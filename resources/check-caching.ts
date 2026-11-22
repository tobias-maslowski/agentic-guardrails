import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isMonorepo, projects, toPosix } from './context.ts';
import { readText, walk } from './source-utils.ts';
import { analyzeFile } from './request-reads.ts';
import { firstHop, reachableFrom } from './resolve-import.ts';
import { inScope, isDiffScoped } from './scope.ts';
import { cacheHeaderWrites, setsNoStoreEverywhere } from './cache-headers.ts';

/**
 * Caching Check (scripts/check-caching.ts) - deterministic heuristic, no network.
 *
 * A route (src/pages page or endpoint) or middleware that really reads request cookies, `Astro.session`, or the
 * `cookie` / `authorization` request header (also through its import chain: layouts, components, helpers) serves
 * personalised content. Its response path must set `Cache-Control` with `no-store` or `private`; otherwise a shared
 * cache can serve one member's response to another.
 *
 * The rule is satisfied by (any of):
 *  - the route, or a file in its import chain (layout), setting `Cache-Control` with no-store|private;
 *  - a src/middleware file setting it (applies to every response), or a `public/_headers` `/*` block setting it;
 *  - an opt-out comment in the route or the reading file: `// guardrails-allow: caching <reason>` (the reason is required).
 * Only cookie/session/auth-header reads count; `Astro.url`, `locals` without session/user and other request data do not.
 * Detection is AST based (cache-headers.ts): a header write counts, a comment or string that merely mentions it does not;
 * a write inside a conditional branch only counts when the personalised read sits in the same branch. A middleware or
 * worker-entry wrapper that sets the header unconditionally (e.g. on the response returned by `next()` /
 * `env.ASSETS.fetch`) covers all routes.
 *
 * Diff-aware: with a scope (see scope.ts) only routes in the scope are checked, unless a middleware or `_headers`
 * file is in the scope (then every route is re-checked).
 */

interface Finding { file: string; line: number; message: string; fix: string }
const errors: Finding[] = [];

const CACHE_OK = (text: string): boolean => /cache-control/i.test(text) && /\b(no-store|private)\b/i.test(text);
const ALLOW_RE = /guardrails-allow:\s*caching\b([^\n]*)/i;
const SOURCE = /\.(ts|tsx|mts|js|jsx|mjs|astro)$/;
const isTest = (rel: string): boolean => /\.(test|spec)\.|(^|\/)(__tests__|tests?|e2e)\//.test(rel) || rel.endsWith('.d.ts');
const isMiddleware = (rel: string): boolean => /(^|\/)src\/middleware(\/index)?\.(ts|js|mjs|mts)$/.test(rel);
const isWorkerEntry = (rel: string): boolean => /(^|\/)src\/(worker(\/[\w.-]+)?|_worker|entry[\w.-]*|index)\.(ts|js|mjs|mts)$/.test(rel);

function allowReason(raw: string): { present: boolean; reason: string } {
  const m = raw.match(ALLOW_RE);
  if (!m) return { present: false, reason: '' };
  return { present: true, reason: m[1].replace(/(-->|\*\/)\s*$/, '').trim() };
}

/** `public/_headers` blocks under `/*` that set no-store|private. */
function headersFileSafe(projectAbs: string): boolean {
  for (const f of ['public/_headers', '_headers']) {
    const p = path.join(projectAbs, f);
    if (!fs.existsSync(p)) continue;
    const m = readText(p).match(/^\/\*[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m);
    if (m && CACHE_OK(m[1])) return true;
  }
  return false;
}

const files = new Map<string, { rel: string; raw: string }>();
const headersFiles: string[] = [];
for (const project of projects) {
  for (const abs of walk(path.join(project.abs, 'src'), { accept: (n) => SOURCE.test(n) })) {
    const rel = toPosix(path.relative(ROOT, abs));
    if (!isTest(rel)) files.set(abs, { rel, raw: readText(abs) });
  }
  for (const f of ['public/_headers', '_headers']) if (fs.existsSync(path.join(project.abs, f))) headersFiles.push(path.join(project.abs, f));
}

const routes: Array<{ abs: string; projectAbs: string }> = [];
for (const project of projects) {
  for (const [abs, f] of files) {
    if (!abs.startsWith(project.abs + path.sep)) continue;
    if (isMiddleware(f.rel)) routes.push({ abs, projectAbs: project.abs });
    else if (/(^|\/)src\/pages\//.test(f.rel) && !f.rel.split('/').some((s) => s.startsWith('_'))) routes.push({ abs, projectAbs: project.abs });
  }
}

const globalChanged = !isDiffScoped || [...files.keys()].some((a) => (isMiddleware(files.get(a)!.rel) || isWorkerEntry(files.get(a)!.rel)) && inScope(a)) || headersFiles.some((a) => inScope(a));
const middlewareSafe = (projectAbs: string): boolean =>
  [...files].some(([abs, f]) => abs.startsWith(projectAbs + path.sep) && (isMiddleware(f.rel) || isWorkerEntry(f.rel)) && setsNoStoreEverywhere(abs)) || headersFileSafe(projectAbs);

let checked = 0;
let optedOut = 0;
for (const { abs, projectAbs } of routes) {
  if (!globalChanged && !inScope(abs)) continue;
  checked++;
  const info = files.get(abs)!;
  const graph = reachableFrom(abs);
  const readers: Array<{ file: string; line: number }> = [];
  let safe = middlewareSafe(projectAbs);
  let allowed = false;
  for (const [file] of graph) {
    const raw = files.get(file)?.raw ?? '';
    const a = allowReason(raw);
    if (a.present) {
      if (a.reason) allowed = true;
      else errors.push({ file: toPosix(path.relative(ROOT, file)), line: 1, message: '`guardrails-allow: caching` has no reason.', fix: 'Write `// guardrails-allow: caching <why this response is safe to cache>`.' });
    }
    const reads = analyzeFile(file).reads.filter((r) => r.kind === 'cookies' || r.kind === 'session' || r.kind === 'cookie-header' || (r.kind === 'locals' && /locals\.(session|user|member|auth)/i.test(raw)));
    if (reads.length > 0) readers.push({ file, line: reads[0].line });
    if (cacheHeaderWrites(file, reads.map((r) => r.line)).some((w) => w.unconditional || w.coversReads)) safe = true;
  }
  if (readers.length === 0 || safe) continue;
  if (allowed) { optedOut++; continue; }
  const r = readers[0];
  const hop = r.file === abs ? null : firstHop(abs, r.file, graph);
  const where = r.file === abs ? '' : ` (via ${toPosix(path.relative(ROOT, r.file))}:${r.line})`;
  errors.push({
    file: info.rel,
    line: r.file === abs ? r.line : hop?.line ?? 1,
    message: `reads cookies/session${where} but no response in its path sets \`Cache-Control\` with no-store or private, so a shared cache can serve one member's page to another.`,
    fix: "Set `Astro.response.headers.set('Cache-Control', 'private, no-store')` (page/layout), set it on the endpoint Response, set it once in src/middleware or public/_headers, or add `// guardrails-allow: caching <reason>`.",
  });
}

if (routes.length === 0 && isMonorepo) {
  errors.push({ file: '.', line: 1, message: 'found 0 routes or middleware under src/; the check would pass vacuously.', fix: 'Check guardrails.config.ts -> workspaces (or run it in a project with a src/ folder).' });
}
if (errors.length > 0) {
  console.error(`\n❌ Caching Check Failed (${errors.length} finding(s)):\n`);
  for (const f of errors) console.error(`  • ${f.file}:${f.line}  ${f.message}\n      fix: ${f.fix}`);
  console.error('');
  process.exit(1);
}
console.log(`✅ Caching Check Passed (${checked}/${routes.length} route(s) checked${isDiffScoped ? ', diff-scoped' : ''}${optedOut ? `, ${optedOut} opted out` : ''}).`);
