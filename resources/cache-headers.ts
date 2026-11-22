import path from 'node:path';
import { ts } from './ts-api.ts';
import { astroBlocks, readText } from './source-utils.ts';

/**
 * AST detection of "this code sets `Cache-Control` with no-store|private on a response". Comments and string
 * literals that are not header writes never count. Recognised writes:
 *  - `x.headers.set|append|setHeader('Cache-Control', 'private, no-store')` (also `Astro.response.headers.set`)
 *  - an object literal property `'Cache-Control': '...'` (`new Headers({...})`, `Response` init `headers: {...}`)
 *  - a header tuple `['Cache-Control', '...']`
 * A write nested in a conditional branch (`if`/`?:`/`&&`/`||`/`??`/`switch`/`catch`) only counts when `readLines`
 * (the personalised reads of the same file) fall inside that same branch; otherwise it is "conditional" and ignored.
 */

export interface HeaderWrite {
  line: number;
  /** Not nested in any conditional branch: applies to every response of the enclosing code. */
  unconditional: boolean;
  /** Conditional, but every enclosing branch contains one of the personalised reads. */
  coversReads: boolean;
}

const SAFE_VALUE = /\b(no-store|private)\b/i;
const HEADER = /^cache-control$/i;

function strings(node: ts.Node | undefined): string {
  if (!node) return '';
  let out = '';
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out += ` ${n.text}`;
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out += ` ${n.text}`;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function branchOf(node: ts.Node): ts.Node | null {
  const p = node.parent;
  if (!p) return null;
  if (ts.isIfStatement(p) && (p.thenStatement === node || p.elseStatement === node)) return node;
  if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) return node;
  if (ts.isBinaryExpression(p) && p.right === node && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return node;
  if (ts.isCaseClause(p) || ts.isDefaultClause(p)) return p;
  if (ts.isCatchClause(p) && p.block === node) return node;
  return null;
}

function analyzeCode(code: string, fileName: string, lineOffset: number, readLines: number[]): HeaderWrite[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith('.js') || fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + lineOffset;
  const writes: HeaderWrite[] = [];
  const record = (n: ts.Node): void => {
    let unconditional = true;
    let covers = true;
    for (let cur: ts.Node | undefined = n; cur && !ts.isSourceFile(cur); cur = cur.parent) {
      const b = branchOf(cur);
      if (!b) continue;
      unconditional = false;
      const start = lineOf(b);
      const end = sf.getLineAndCharacterOfPosition(b.getEnd()).line + lineOffset;
      if (!readLines.some((l) => l >= start && l <= end)) covers = false;
    }
    writes.push({ line: lineOf(n), unconditional, coversReads: covers });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['set', 'append', 'setHeader'].includes(n.expression.name.text)) {
      const [name, value] = n.arguments;
      if (name && ts.isStringLiteralLike(name) && HEADER.test(name.text) && SAFE_VALUE.test(strings(value))) record(n);
    } else if (ts.isPropertyAssignment(n)) {
      const key = ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name) ? n.name.text : '';
      if (HEADER.test(key) && SAFE_VALUE.test(strings(n.initializer))) record(n);
    } else if (ts.isArrayLiteralExpression(n) && n.elements.length === 2 && ts.isStringLiteralLike(n.elements[0]) && HEADER.test(n.elements[0].text) && SAFE_VALUE.test(strings(n.elements[1]))) {
      record(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return writes;
}

const cache = new Map<string, string>();
export function cacheHeaderWrites(abs: string, readLines: number[] = []): HeaderWrite[] {
  try {
    const raw = cache.get(abs) ?? readText(abs);
    cache.set(abs, raw);
    if (abs.endsWith('.astro')) return astroBlocks(raw).flatMap((b) => analyzeCode(b.code, abs + '.ts', b.line - 1, readLines));
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(abs)) return analyzeCode(raw, path.basename(abs), 0, readLines);
  } catch {
    // unparsable files are reported by check:imports
  }
  return [];
}

/** True when the file sets the header on every response (no conditional branch around the write). */
export const setsNoStoreEverywhere = (abs: string): boolean => cacheHeaderWrites(abs).some((w) => w.unconditional);
