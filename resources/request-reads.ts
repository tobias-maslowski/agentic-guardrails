import { ts } from './ts-api.ts';
import { astroBlocks, readText } from './source-utils.ts';

/**
 * Detects reads of request-dependent data (cookies, headers, locals, query string, body, client address,
 * session) in `.astro` files (frontmatter and template) and in `.ts/.js` endpoints, middleware and helpers.
 * Heuristic: it recognises `Astro.*`, `context.*` / `ctx.*` (APIContext parameters), destructured
 * `{ cookies, request, locals, url }` handler parameters and typed helper parameters.
 */

export type ReadKind = 'cookies' | 'headers' | 'cookie-header' | 'locals' | 'search-params' | 'body' | 'client-address' | 'session';
export interface RequestRead {
  line: number;
  what: string;
  kind: ReadKind;
}
export interface FileAnalysis {
  reads: RequestRead[];
  prerender: boolean | 'unknown' | undefined;
}

const REQUEST_PATHS: Array<{ prefix: string; label: string; kind: ReadKind }> = [
  { prefix: 'Astro.cookies', label: 'Astro.cookies', kind: 'cookies' },
  { prefix: 'Astro.session', label: 'Astro.session', kind: 'session' },
  { prefix: 'Astro.locals', label: 'Astro.locals', kind: 'locals' },
  { prefix: 'Astro.clientAddress', label: 'Astro.clientAddress', kind: 'client-address' },
  { prefix: 'Astro.request.headers', label: 'Astro.request.headers', kind: 'headers' },
  { prefix: 'Astro.request.body', label: 'Astro.request.body', kind: 'body' },
  { prefix: 'Astro.request.json', label: 'Astro.request.json()', kind: 'body' },
  { prefix: 'Astro.request.formData', label: 'Astro.request.formData()', kind: 'body' },
  { prefix: 'Astro.request.text', label: 'Astro.request.text()', kind: 'body' },
  { prefix: 'Astro.url.searchParams', label: 'Astro.url.searchParams', kind: 'search-params' },
];
const ALIASABLE = new Set(['cookies', 'locals', 'clientAddress', 'request', 'url', 'session']);
const HANDLER_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'HEAD', 'OPTIONS', 'onRequest', 'handler']);
const ROOT_PARAM_NAMES = new Set(['context', 'ctx', 'Astro']);

const cache = new Map<string, FileAnalysis>();

/** Dotted path of `a.b.c` / `a['b']` / `a.b().c` chains rooted at an identifier, or null. */
function chainOf(node: ts.Node): string[] | null {
  const parts: string[] = [];
  let cur: ts.Node = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) { parts.unshift(cur.name.text); cur = cur.expression; }
    else if (ts.isElementAccessExpression(cur) && ts.isStringLiteralLike(cur.argumentExpression)) { parts.unshift(cur.argumentExpression.text); cur = cur.expression; }
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur) && (ts.isPropertyAccessExpression(cur.expression) || ts.isIdentifier(cur.expression))) cur = cur.expression;
    else break;
  }
  if (!ts.isIdentifier(cur)) return null;
  return [cur.text, ...parts];
}

function kindOf(file: string, inAstro: boolean): ts.ScriptKind {
  if (inAstro) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function analyzeCode(code: string, file: string, lineOffset: number, inAstro: boolean): FileAnalysis {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kindOf(file, inAstro));
  const aliases = new Map<string, string>([['Astro', 'Astro']]); // local name -> canonical prefix
  const reads: RequestRead[] = [];
  let prerender: boolean | 'unknown' | undefined;
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + lineOffset;
  const typeText = (n: ts.Node | undefined): string => (n ? n.getText(sf) : '');

  const bindPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const el of pattern.elements) {
      const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
      if (ALIASABLE.has(prop) && ts.isIdentifier(el.name)) aliases.set(el.name.text, `Astro.${prop}`);
    }
  };
  const isHandler = (fn: ts.Node): boolean => {
    const p = fn.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && HANDLER_NAMES.has(p.name.text)) return true;
    if (ts.isFunctionDeclaration(fn) && fn.name && HANDLER_NAMES.has(fn.name.text)) return true;
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(defineMiddleware|sequence)$/.test(p.expression.text)) return true;
    if (ts.isExportAssignment(p)) return true;
    return false;
  };

  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && ts.isObjectBindingPattern(n.name)) {
      const init = n.initializer.text;
      if (init === 'Astro' || aliases.get(init) === 'Astro') bindPattern(n.name);
    }
    if (ts.isParameter(n)) {
      const t = typeText(n.type);
      if (ts.isIdentifier(n.name)) {
        const name = n.name.text;
        if (ROOT_PARAM_NAMES.has(name) && (!n.type || /APIContext|AstroGlobal|MiddlewareContext|APIRoute/.test(t))) aliases.set(name, 'Astro');
        else if (name === 'cookies' && /Cookies/.test(t)) aliases.set(name, 'Astro.cookies');
        else if (name === 'request' && /\bRequest\b/.test(t)) aliases.set(name, 'Astro.request');
        else if (name === 'locals' && /Locals/.test(t)) aliases.set(name, 'Astro.locals');
      } else if (ts.isObjectBindingPattern(n.name)) {
        const fn = n.parent;
        if (isHandler(fn) || /APIContext|AstroGlobal|MiddlewareContext/.test(t)) bindPattern(n.name);
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const isRequestPath = (dotted: string): { label: string; kind: ReadKind } | null => {
    for (const r of REQUEST_PATHS) if (dotted === r.prefix || dotted.startsWith(r.prefix + '.')) return r;
    return null;
  };
  const canonical = (chain: string[]): string => {
    const root = aliases.get(chain[0]);
    return (root ? [...root.split('.'), ...chain.slice(1)] : chain).join('.');
  };

  const visit = (n: ts.Node): void => {
    if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === 'prerender') {
          if (d.initializer?.kind === ts.SyntaxKind.TrueKeyword) prerender = true;
          else if (d.initializer?.kind === ts.SyntaxKind.FalseKeyword) prerender = false;
          else prerender = 'unknown';
        }
      }
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const chain = chainOf(n);
      if (chain) {
        const r = isRequestPath(canonical(chain));
        if (r && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) {
          let kind = r.kind;
          if (kind === 'headers') {
            const call = n.parent?.parent;
            const getter = ts.isPropertyAccessExpression(n.parent) ? n.parent : null;
            const argNode = call && ts.isCallExpression(call) && getter && call.expression === getter ? call.arguments[0] : undefined;
            if (argNode && ts.isStringLiteralLike(argNode) && /^(cookie|authorization)$/i.test(argNode.text)) kind = 'cookie-header';
          }
          reads.push({ line: lineOf(n), what: r.label, kind });
        }
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'searchParams' && ts.isNewExpression(n.expression)) {
        const arg = n.expression.arguments?.[0];
        const argChain = arg ? chainOf(arg) : null;
        if (argChain) {
          const dotted = canonical(argChain);
          if (dotted === 'Astro.request.url' || dotted === 'Astro.url' || dotted.startsWith('Astro.url.')) {
            reads.push({ line: lineOf(n), what: 'URL(...).searchParams of the request URL', kind: 'search-params' });
          }
        }
      }
    }
    if (ts.isIdentifier(n) && n.text === 'Astro' && ts.isSpreadAssignment(n.parent)) reads.push({ line: lineOf(n), what: 'spread of Astro', kind: 'locals' });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { reads, prerender };
}

function templateReads(content: string): RequestRead[] {
  const masked = content
    .replace(/^\s*---\n[\s\S]*?\n---/, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, ' '));
  const out: RequestRead[] = [];
  const re = /\bAstro\.(cookies|session|locals|clientAddress|request\.headers|url\.searchParams)\b/g;
  const kinds: Record<string, ReadKind> = { cookies: 'cookies', session: 'session', locals: 'locals', clientAddress: 'client-address', 'request.headers': 'headers', 'url.searchParams': 'search-params' };
  for (const m of masked.matchAll(re)) out.push({ line: masked.slice(0, m.index).split('\n').length, what: `Astro.${m[1]}`, kind: kinds[m[1]] });
  return out;
}

/** Request-data reads and the literal `prerender` export of one source file (cached). */
export function analyzeFile(abs: string): FileAnalysis {
  const hit = cache.get(abs);
  if (hit) return hit;
  let result: FileAnalysis = { reads: [], prerender: undefined };
  try {
    const raw = readText(abs);
    if (abs.endsWith('.astro')) {
      const fm = astroBlocks(raw).find((b) => b.kind === 'frontmatter');
      const a = fm ? analyzeCode(fm.code, abs, fm.line, true) : { reads: [], prerender: undefined };
      result = { reads: [...a.reads, ...templateReads(raw)].sort((x, y) => x.line - y.line), prerender: a.prerender };
    } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(abs)) {
      result = analyzeCode(raw, abs, 1, false);
    }
  } catch {
    // unparsable files are reported by check:imports
  }
  cache.set(abs, result);
  return result;
}
