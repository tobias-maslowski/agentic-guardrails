import fs from 'node:fs';
import path from 'node:path';
import { ts } from './ts-api.ts';
import { ROOT, declaredDeps, projects, toPosix, type Project } from './context.ts';
import { readText, walk } from './source-utils.ts';
import { analyzeFile } from './request-reads.ts';
import { firstHop, reachableFrom } from './resolve-import.ts';
import { inScope } from './scope.ts';

/**
 * SSR / Prerender Consistency Checker (scripts/check-ssr.ts)
 *
 * In every Astro workspace, a route under `src/pages` (`.astro` pages and `.ts/.js` API endpoints; files and
 * folders starting with `_` are not routes) that is prerendered must not read request-dependent data
 * (`Astro.cookies`, `Astro.request.headers`, `Astro.locals`, `Astro.url.searchParams`, `Astro.clientAddress`,
 * `context.cookies`, `cookies.get`, `request.headers`, also via destructuring/aliases and typed helper parameters).
 * The reads are searched in the route itself AND transitively through its imports (components, layouts, lib helpers,
 * `.astro` and `.ts`, workspace packages); the report names the route line and the reaching file:line.
 *  - `export const prerender = true` + request data           => error
 *  - no `prerender` export + astro.config `output` not 'server' => error (the route is prerendered at build time)
 *  - `export const prerender = false`, or `output: 'server'` as default => ok
 * A `prerender` value that is not a literal is reported as "undecidable" (advisory, not an error).
 * Diff-aware: with a scope (scope.ts) only routes in the scope (changed files plus their importers) are analysed.
 * Heuristic: reachability follows imports, not calls; a helper that is imported but never called still counts.
 */

const CONFIG_NAMES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'];
interface Finding { file: string; line: number; message: string; fix: string }
const errors: Finding[] = [];
const notes: string[] = [];

function configOutput(project: Project): 'server' | 'static' | 'unknown' {
  const name = CONFIG_NAMES.find((n) => fs.existsSync(path.join(project.abs, n)));
  if (!name) return 'static';
  const sf = ts.createSourceFile(name, readText(path.join(project.abs, name)), ts.ScriptTarget.Latest, true);
  let value: 'server' | 'static' | 'unknown' = 'static';
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'output') {
      const init = n.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) value = init.text === 'server' ? 'server' : 'static';
      else value = 'unknown';
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return value;
}

let astroProjects = 0;
let routesScanned = 0;

const ROUTE_EXT = /\.(astro|ts|tsx|mts|js|jsx|mjs)$/;
const isRoute = (rel: string): boolean => ROUTE_EXT.test(rel) && !rel.endsWith('.d.ts') && !/\.(test|spec)\./.test(rel) && !rel.split('/').some((seg) => seg.startsWith('_'));

for (const project of projects) {
  const deps = declaredDeps(project.pkg);
  const hasConfig = CONFIG_NAMES.some((n) => fs.existsSync(path.join(project.abs, n)));
  if (!deps.has('astro') && !hasConfig) continue;
  astroProjects++;
  const output = configOutput(project);
  if (output === 'unknown') notes.push(`${project.dir || '.'}: astro.config \`output\` is not a string literal; assuming 'static' (prerendered by default).`);
  const pagesDir = path.join(project.abs, 'src/pages');
  for (const abs of walk(pagesDir, { accept: (n) => ROUTE_EXT.test(n) })) {
    const relToPages = toPosix(path.relative(pagesDir, abs));
    if (!isRoute(relToPages) || !inScope(abs)) continue;
    routesScanned++;
    const rel = toPosix(path.relative(ROOT, abs));
    const kind = abs.endsWith('.astro') ? 'page' : 'endpoint';
    const own = analyzeFile(abs);
    const prerendered = own.prerender === true || (own.prerender === undefined && output !== 'server');

    if (own.reads.length > 0) {
      const first = own.reads[0];
      const what = [...new Set(own.reads.map((h) => h.what))].join(', ');
      if (own.prerender === true) {
        errors.push({
          file: rel, line: first.line,
          message: `${kind} is prerendered (\`export const prerender = true\`) but reads request data (${what}); the values are frozen at build time.`,
          fix: 'Remove `prerender = true` or set `export const prerender = false`, or stop reading request data here.',
        });
      } else if (own.prerender === 'unknown') {
        notes.push(`${rel}:${first.line}: reads ${what} but \`prerender\` is not a literal; verify it is false.`);
      } else if (prerendered) {
        errors.push({
          file: rel, line: first.line,
          message: `${kind} reads request data (${what}) but is prerendered: astro.config has no \`output: 'server'\` and the ${kind} does not export \`prerender = false\`.`,
          fix: "Add `export const prerender = false;` to the file, or set `output: 'server'` (with an adapter) in astro.config.",
        });
      }
    }

    if (prerendered) {
      const graph = reachableFrom(abs);
      for (const [file] of graph) {
        if (file === abs) continue;
        const reads = analyzeFile(file).reads;
        if (reads.length === 0) continue;
        const hop = firstHop(abs, file, graph);
        const via = toPosix(path.relative(ROOT, file));
        const what = [...new Set(reads.map((h) => h.what))].join(', ');
        errors.push({
          file: rel, line: hop?.line ?? 1,
          message: `${kind} is prerendered but imports ${via}:${reads[0].line}, which reads request data (${what}); the values are frozen at build time.`,
          fix: `Make the ${kind} on-demand (\`export const prerender = false;\` or \`output: 'server'\`), or move the request read out of the import chain (pass the data in from an on-demand route).`,
        });
      }
    }
  }
}

for (const n of notes) console.log(`ℹ️  ${n}`);
if (errors.length > 0) {
  console.error(`\n❌ SSR/Prerender Check Failed (${errors.length} finding(s)):\n`);
  for (const f of errors) console.error(`  • ${f.file}:${f.line}  ${f.message}\n      fix: ${f.fix}`);
  console.error('');
  process.exit(1);
}
console.log(
  astroProjects === 0
    ? '⏭️  SSR check skipped: no Astro workspace found.'
    : `✅ SSR/Prerender Check Passed (${routesScanned} route(s) in ${astroProjects} Astro workspace(s); reads followed through imports).`
);
