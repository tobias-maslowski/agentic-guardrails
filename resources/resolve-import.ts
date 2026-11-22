import fs from 'node:fs';
import path from 'node:path';
import { ts } from './ts-api.ts';
import { projects, type Project } from './context.ts';
import { astroBlocks, readText } from './source-utils.ts';

/**
 * Import graph helpers shared by check:ssr and check:security: list the imports of a file (with lines) and
 * resolve a specifier to a source file inside the repository (relative paths, tsconfig `paths` aliases and
 * workspace packages through their `exports` map). External npm packages resolve to null.
 */

export interface ImportRef {
  spec: string;
  line: number;
  typeOnly: boolean;
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.astro'];
const importCache = new Map<string, ImportRef[]>();

const literal = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

function kindOf(file: string, inAstro: boolean): ts.ScriptKind {
  if (inAstro) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collect(code: string, file: string, lineOffset: number, inAstro: boolean): ImportRef[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kindOf(file, inAstro));
  const out: ImportRef[] = [];
  const add = (spec: string | null, node: ts.Node, typeOnly: boolean): void => {
    if (spec !== null) out.push({ spec, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + lineOffset, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allTypeNamed = !!named && ts.isNamedImports(named) && !clause?.name && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      add(literal(node.moduleSpecifier), node, !!clause?.isTypeOnly || allTypeNamed);
    } else if (ts.isExportDeclaration(node)) {
      add(literal(node.moduleSpecifier), node, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) add(literal(node.arguments[0]), node, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Imports of a file. For `.astro` only the frontmatter is followed unless `scripts` is true. */
export function importsOf(abs: string, scripts = false): ImportRef[] {
  const key = `${abs}|${scripts}`;
  const cached = importCache.get(key);
  if (cached) return cached;
  let out: ImportRef[] = [];
  try {
    const raw = readText(abs);
    out = abs.endsWith('.astro')
      ? astroBlocks(raw).filter((b) => scripts || b.kind === 'frontmatter').flatMap((b) => collect(b.code, abs, b.line, true))
      : collect(raw, abs, 1, false);
  } catch {
    out = [];
  }
  importCache.set(key, out);
  return out;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function probe(p: string): string | null {
  if (isFile(p) && EXTS.some((e) => p.endsWith(e))) return p;
  const noJs = p.replace(/\.(m?js|jsx)$/, '');
  for (const base of noJs !== p ? [p, noJs] : [p]) {
    for (const e of EXTS) if (isFile(base + e)) return base + e;
  }
  for (const e of EXTS) if (isFile(path.join(p, 'index' + e))) return path.join(p, 'index' + e);
  return null;
}

const ownerOf = (abs: string): Project | null => {
  let best: Project | null = null;
  for (const p of projects) {
    const rel = path.relative(p.abs, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || p.abs.length > best.abs.length)) best = p;
  }
  return best;
};

const aliasCache = new Map<string, Array<{ pattern: string; targets: string[] }>>();
function aliasesOf(project: Project): Array<{ pattern: string; targets: string[] }> {
  const hit = aliasCache.get(project.abs);
  if (hit) return hit;
  const out: Array<{ pattern: string; targets: string[] }> = [];
  const cfg = path.join(project.abs, 'tsconfig.json');
  if (fs.existsSync(cfg)) {
    try {
      const parsed = ts.readConfigFile(cfg, (f) => fs.readFileSync(f, 'utf8'));
      const opts = parsed.config?.compilerOptions ?? {};
      const base = path.resolve(project.abs, typeof opts.baseUrl === 'string' ? opts.baseUrl : '.');
      for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
        if (Array.isArray(targets)) out.push({ pattern, targets: targets.filter((t) => typeof t === 'string').map((t: string) => path.resolve(base, t)) });
      }
    } catch {
      // unreadable tsconfig: no aliases
    }
  }
  aliasCache.set(project.abs, out);
  return out;
}

const CONDITIONS = ['import', 'default', 'astro', 'node', 'module', 'require', 'types'];
function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = exportTarget(v);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>;
    for (const c of [...CONDITIONS, ...Object.keys(map)]) if (Object.hasOwn(map, c)) {
      const r = exportTarget(map[c]);
      if (r) return r;
    }
  }
  return null;
}

function resolveWorkspace(target: Project, sub: string): string | null {
  const exp = target.pkg.exports;
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))) {
    const map = exp as Record<string, unknown>;
    const key = sub === '' ? '.' : `.${sub}`;
    let rel: string | null = null;
    if (Object.hasOwn(map, key)) rel = exportTarget(map[key]);
    else {
      let bestLen = -1;
      for (const k of Object.keys(map)) {
        const star = k.indexOf('*');
        if (star < 0) continue;
        const pre = k.slice(0, star);
        const post = k.slice(star + 1);
        if (key.length >= pre.length + post.length && key.startsWith(pre) && key.endsWith(post) && pre.length > bestLen) {
          const t = exportTarget(map[k]);
          if (t) {
            bestLen = pre.length;
            rel = t.replace('*', key.slice(pre.length, key.length - post.length));
          }
        }
      }
    }
    return rel ? probe(path.resolve(target.abs, rel)) : null;
  }
  const entry = exportTarget(exp) ?? (typeof target.pkg.module === 'string' ? target.pkg.module : typeof target.pkg.main === 'string' ? target.pkg.main : null);
  if (sub === '') return probe(entry ? path.resolve(target.abs, entry) : path.join(target.abs, 'index'));
  return probe(path.join(target.abs, sub));
}

/** Absolute path of the source file `spec` refers to, or null for external packages / unresolvable specifiers. */
export function resolveImport(fromAbs: string, rawSpec: string): string | null {
  const spec = rawSpec.replace(/[?#].*$/, '');
  if (!spec) return null;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return probe(path.resolve(path.dirname(fromAbs), spec));
  const owner = ownerOf(fromAbs);
  if (owner) {
    for (const { pattern, targets } of aliasesOf(owner)) {
      const star = pattern.indexOf('*');
      const match = star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1;
      if (!match) continue;
      const mid = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const t of targets) {
        const r = probe(t.replace('*', mid));
        if (r) return r;
      }
    }
  }
  if (/^[a-zA-Z][\w+.-]*:/.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const target = projects.find((p) => p.name === name);
  return target ? resolveWorkspace(target, spec.slice(name.length)) : null;
}

/** Transitive closure of source files reachable from `start` (including it), with the first import edge that reached each file. */
export function reachableFrom(start: string, opts: { scripts?: boolean; includeTypeOnly?: boolean } = {}): Map<string, { from: string | null; line: number }> {
  const seen = new Map<string, { from: string | null; line: number }>([[start, { from: null, line: 0 }]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const imp of importsOf(cur, opts.scripts ?? false)) {
      if (imp.typeOnly && !opts.includeTypeOnly) continue;
      const next = resolveImport(cur, imp.spec);
      if (next && !seen.has(next)) {
        seen.set(next, { from: cur, line: imp.line });
        queue.push(next);
      }
    }
  }
  return seen;
}

/** The import edge leaving `start` that eventually reaches `target` (for "page:line -> reaching file:line" reports). */
export function firstHop(start: string, target: string, graph: Map<string, { from: string | null; line: number }>): { file: string; line: number } | null {
  let cur: string = target;
  while (cur !== start) {
    const e = graph.get(cur);
    if (!e || e.from === null) return null;
    if (e.from === start) return { file: e.from, line: e.line };
    cur = e.from;
  }
  return null;
}
