import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ts } from './ts-api.ts';
import { DEP_SECTIONS, ROOT, declaredDeps, guardrailsConfig, projects, readJson, toPosix, type Project } from './context.ts';
import { DEFAULT_IGNORED_DIRS, astroBlocks, readText, walk } from './source-utils.ts';
import { inScope, isDiffScoped } from './scope.ts';
import { resolveImport } from './resolve-import.ts';
import { DEFAULT_TEST_GLOBS } from './defaults.ts';
import { loadLayersFile } from './layers-file.ts';

/**
 * Workspace Boundary Checker (scripts/check-imports.ts)
 *
 * Scans every workspace (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .astro`; `.astro` frontmatter and
 * `<script>` blocks are parsed with the TypeScript API; static, side-effect, re-export, dynamic `import()`,
 * `import x = require()` and `require()` are all covered) and reports `file:line` with the fix for:
 *  a. relative imports that resolve outside their own workspace;
 *  b. imports of another workspace by package name that is not declared in the importer's package.json
 *     (dependencies, devDependencies, peerDependencies or optionalDependencies);
 *  c. subpath imports (`@scope/pkg/sub`) that the target's package.json `exports` does not expose
 *     (exact keys, `./*` patterns, legacy `./dir/` keys, conditions objects; no `exports` => main entry only);
 *  d. layer rules from `config.layers` (low -> high; strictly lower layers only; unlisted workspaces are errors);
 *  e. circular workspace dependencies (declared dependencies plus actual imports);
 *  f. a scan that found 0 files;
 *  g. imports of external npm packages that the importing workspace's package.json does not declare (node: builtins,
 *     `cloudflare:*` / `astro:*` style schemes, `virtualModules`, `@types/*`, tsconfig aliases and workspace packages are exempt;
 *     test/config files may also use the root devDependencies);
 *     Bundler aliases (`resolve.alias` / `vite.resolve.alias` in astro|vite.config.*, static literals), tsconfig `paths`
 *     and `virtualModules` globs are exempt; undeclared packages are reported once with a count and the first 3 locations;
 *  h. `externalRules`: per workspace `forbid` globs (e.g. 'node:*', 'cloudflare:*', '@storyblok/*') and optional `allowOnly` globs.
 * Test files (config `testGlobs`) are exempt from g and h. Diff-aware: with a scope (scope.ts) only files in the scope are scanned.
 */

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|astro)$/;
const isSource = (name: string): boolean => SOURCE_FILE.test(name) && !name.endsWith('.d.ts');
const ignoredDirs = new Set([...DEFAULT_IGNORED_DIRS, ...((guardrailsConfig.importScanIgnoreDirs as string[] | undefined) ?? [])]);

interface Finding {
  file: string;
  line: number;
  message: string;
  fix: string;
}
const findings: Finding[] = [];
const report = (file: string, line: number, message: string, fix: string): void => {
  findings.push({ file, line, message, fix });
};

// ---------- workspace tables ----------

const byName = new Map<string, Project>(projects.map((p) => [p.name, p]));

const ownerOf = (abs: string): Project | null => {
  let best: Project | null = null;
  for (const p of projects) {
    const rel = path.relative(p.abs, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || p.abs.length > best.abs.length)) best = p;
  }
  return best;
};

// ---------- layers ----------

interface Layer {
  name: string;
  patterns: string[];
  devOnly?: boolean;
}

function normalizeLayers(raw: unknown): Layer[] | null {
  if (raw === undefined || raw === null) return null;
  const bad = (msg: string): never => {
    console.error(`❌ guardrails.config.ts \`layers\` is invalid: ${msg}\n   Use string[][] or { name: string, workspaces: string[] }[] (low -> high).`);
    process.exit(1);
  };
  if (!Array.isArray(raw) || raw.length === 0) return bad('expected a non-empty array');
  return raw.map((entry, i): Layer => {
    if (Array.isArray(entry) && entry.every((x) => typeof x === 'string') && entry.length > 0) {
      return { name: `layer ${i + 1}`, patterns: entry };
    }
    if (
      entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof (entry as any).name === 'string' && Array.isArray((entry as any).workspaces) &&
      (entry as any).workspaces.length > 0 && (entry as any).workspaces.every((x: unknown) => typeof x === 'string')
    ) {
      return { name: (entry as any).name, patterns: (entry as any).workspaces };
    }
    return bad(`entry ${i} must be a non-empty string[] or { name, workspaces: string[] }`);
  });
}

const globRe = (pattern: string): RegExp =>
  new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const matchesPattern = (p: Project, pattern: string): boolean => {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  // bare names (`client`) match the last directory segment or the unscoped package name (`@scope/client`)
  if (!clean.includes('/') && !clean.includes('*') && (clean === p.dir.split('/').pop() || clean === p.name.replace(/^@[^/]+\//, ''))) return true;
  return clean === p.name || clean === p.dir || (clean.includes('*') && (globRe(clean).test(p.dir) || globRe(clean).test(p.name)));
};

const layersFileRel: string | undefined = typeof guardrailsConfig.layersFile === 'string' ? guardrailsConfig.layersFile : undefined;
const loadedLayers = (): Layer[] | null => {
  if (!layersFileRel) return null;
  try {
    return loadLayersFile(path.join(ROOT, layersFileRel));
  } catch (err) {
    console.error(`❌ guardrails.config.ts \`layersFile\`: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};
const layers = loadedLayers() ?? normalizeLayers(guardrailsConfig.layers);
const skipRules: string[] = Array.isArray(guardrailsConfig.skipImportRules) ? guardrailsConfig.skipImportRules : [];
const layerOf = new Map<string, number>();
if (layers) {
  const configFile = layersFileRel ?? 'guardrails.config.ts';
  layers.forEach((layer, idx) => {
    for (const pattern of layer.patterns) {
      const hits = projects.filter((p) => matchesPattern(p, pattern));
      if (hits.length === 0) {
        report(configFile, 1, `layers: "${pattern}" (${layer.name}) matches no workspace.`, 'Remove or correct the stale layer entry.');
      }
      for (const p of hits) {
        if (layerOf.has(p.name) && layerOf.get(p.name) !== idx) {
          report(configFile, 1, `workspace "${p.name}" is listed in more than one layer.`, 'List each workspace in exactly one layer.');
        }
        layerOf.set(p.name, idx);
      }
    }
  });
  for (const p of projects) {
    if (!layerOf.has(p.name)) {
      report(
        `${p.dir || '.'}/package.json`, 1,
        `workspace "${p.name}" is not assigned to any layer (layers are configured).`,
        `Add "${p.dir}" to a layer in guardrails.config.ts -> layers.`
      );
    }
  }
}

// ---------- external rules ----------

interface ExternalRule {
  workspaces: string[];
  forbid: string[];
  allowOnly?: string[];
}
function normalizeExternalRules(raw: unknown): ExternalRule[] {
  if (raw === undefined || raw === null) return [];
  const bad = (msg: string): never => {
    console.error(`❌ guardrails.config.ts \`externalRules\` is invalid: ${msg}\n   Use { workspaces: string[], forbid: string[], allowOnly?: string[] }[].`);
    process.exit(1);
  };
  if (!Array.isArray(raw)) return bad('expected an array');
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return raw.map((r, i): ExternalRule => {
    if (!r || typeof r !== 'object' || !strings((r as any).workspaces) || !(r as any).workspaces.length) return bad(`entry ${i} needs a non-empty string[] \`workspaces\``);
    const rf = (r as any).forbid;
    if (rf !== undefined && !strings(rf)) return bad(`entry ${i}: \`forbid\` must be a string[]`);
    if (rf === undefined && (r as any).allowOnly === undefined) return bad(`entry ${i} needs \`forbid\` and/or \`allowOnly\``);
    if ((r as any).allowOnly !== undefined && !strings((r as any).allowOnly)) return bad(`entry ${i}: \`allowOnly\` must be a string[]`);
    return { workspaces: (r as any).workspaces, forbid: rf ?? [], allowOnly: (r as any).allowOnly };
  });
}
const externalRules = normalizeExternalRules(guardrailsConfig.externalRules);
const virtualModules: string[] = Array.isArray(guardrailsConfig.virtualModules) ? guardrailsConfig.virtualModules : [];
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));
const globMatch = (pattern: string, value: string): boolean => new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(value);
const isBuiltin = (spec: string): boolean => spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
/** `fs`, `fs/promises` and `node:fs` are the same module; rules are written against the `node:` form. */
const externalForm = (spec: string): string => (isBuiltin(spec) && !spec.startsWith('node:') ? `node:${spec}` : spec);
const testGlobs: string[] = Array.isArray(guardrailsConfig.testGlobs) ? guardrailsConfig.testGlobs : DEFAULT_TEST_GLOBS;
const pathGlobRe = (g: string): RegExp =>
  new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
const testRes = testGlobs.map(pathGlobRe);
/** Test files may import test-only packages and runtime modules (node:test, ...) that production code of the same package must not. */
const isExemptTestFile = (rel: string): boolean => testRes.some((re) => re.test(rel));
const isTestOrConfigFile = (rel: string): boolean => /\.(test|spec)\.|(^|\/)(tests?|__tests__|e2e)\/|(^|\/)[\w.-]*\.config\.[cm]?[jt]s$/.test(rel);

// ---------- exports map ----------

function exportsAllows(exp: unknown, sub: string): { ok: boolean; keys: string[] } {
  const mainOnly = (): { ok: boolean; keys: string[] } => ({ ok: sub === '', keys: ['.'] });
  if (exp === undefined || exp === null) return { ok: sub === '', keys: [] };
  if (typeof exp === 'string' || Array.isArray(exp)) return mainOnly();
  if (typeof exp !== 'object') return { ok: false, keys: [] };
  const map = exp as Record<string, unknown>;
  const keys = Object.keys(map);
  if (!keys.some((k) => k.startsWith('.'))) return mainOnly(); // conditions object = sugar for "."
  const key = sub === '' ? '.' : `.${sub}`;
  if (Object.hasOwn(map, key)) return { ok: map[key] !== null, keys };
  let best: { len: number; value: unknown } | null = null;
  for (const k of keys) {
    const star = k.indexOf('*');
    if (star >= 0) {
      const pre = k.slice(0, star);
      const post = k.slice(star + 1);
      if (key.length >= pre.length + post.length && key.startsWith(pre) && key.endsWith(post) && (!best || pre.length > best.len)) {
        best = { len: pre.length, value: map[k] };
      }
    } else if (k.endsWith('/') && key.startsWith(k) && (!best || k.length > best.len)) {
      best = { len: k.length, value: map[k] };
    }
  }
  return { ok: best !== null && best.value !== null, keys };
}

// ---------- specifier extraction ----------

interface Spec {
  spec: string;
  line: number;
}

function parseKind(file: string, inAstro: boolean): ts.ScriptKind {
  if (inAstro) return ts.ScriptKind.TS;
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const literal = (n: ts.Node | undefined): string | null =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

function collectSpecs(code: string, file: string, lineOffset: number, inAstro: boolean): Spec[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, parseKind(file, inAstro));
  const out: Spec[] = [];
  const add = (spec: string | null, node: ts.Node): void => {
    if (spec === null) return;
    out.push({ spec, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + lineOffset });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(literal(node.moduleSpecifier), node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(literal(node.moduleReference.expression), node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(literal(node.argument.literal), node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        add(literal(node.arguments[0]), node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function specsOfFile(abs: string): Spec[] {
  const raw = readText(abs);
  if (abs.endsWith('.astro')) {
    return astroBlocks(raw).flatMap((b) => collectSpecs(b.code, abs, b.line, true));
  }
  return collectSpecs(raw, abs, 1, false);
}

// ---------- bundler aliases ----------

const aliasMatchers: Array<(spec: string) => boolean> = [];
const strLit = (n: ts.Node | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
const addAlias = (key: string | RegExp): void => {
  if (key instanceof RegExp) aliasMatchers.push((x) => key.test(x));
  else aliasMatchers.push((x) => x === key || x.startsWith(key.endsWith('/') ? key : `${key}/`));
};
function collectConfigAliases(file: string): void {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return;
  }
  const fromObject = (o: ts.ObjectLiteralExpression): void => {
    for (const prop of o.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name) ? prop.name.text : strLit(prop.name);
      if (key) addAlias(key);
    }
  };
  const fromEntry = (e: ts.Expression): void => {
    if (!ts.isObjectLiteralExpression(e)) return;
    for (const prop of e.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'find') continue;
      const init = prop.initializer;
      const lit = strLit(init);
      if (lit) addAlias(lit);
      else if (ts.isRegularExpressionLiteral(init)) {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(init.text);
        if (m) try { addAlias(new RegExp(m[1], m[2].replace(/[gy]/g, ''))); } catch { /* ignore invalid regex */ }
      }
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ((ts.isIdentifier(n.name) && n.name.text === 'alias') || strLit(n.name) === 'alias')) {
      if (ts.isObjectLiteralExpression(n.initializer)) fromObject(n.initializer);
      else if (ts.isArrayLiteralExpression(n.initializer)) n.initializer.elements.forEach(fromEntry);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
function collectTsconfigPaths(file: string): void {
  const parsed = ts.parseConfigFileTextToJson(file, readText(file));
  const paths = parsed.config?.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object') return;
  for (const key of Object.keys(paths)) {
    const star = key.indexOf('*');
    addAlias(star >= 0 ? new RegExp('^' + key.slice(0, star).replace(/[.+?^${}()|[\]\\]/g, '\\$&') + '.*') : key);
  }
}
for (const dir of [ROOT, ...projects.map((p) => p.abs)]) {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) collectConfigAliases(f);
  }
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) try { collectTsconfigPaths(f); } catch { /* unreadable tsconfig */ }
  }
}
const isAliased = (spec: string): boolean => aliasMatchers.some((m) => m(spec));

// ---------- main scan ----------

const rootDeclared = declaredDeps(readJson(path.join(ROOT, 'package.json')) ?? {}, ['dependencies', 'devDependencies']);
const edges = new Map<string, Set<string>>(projects.map((p) => [p.name, new Set<string>()]));
const edgeSource = new Map<string, string>(); // "a->b" -> where it came from
let scanned = 0;
const undeclared = new Map<string, { project: Project; pkgName: string; hits: string[] }>();

for (const project of projects) {
  for (const dep of declaredDeps(project.pkg, DEP_SECTIONS)) {
    if (byName.has(dep) && dep !== project.name) {
      edges.get(project.name)!.add(dep);
      edgeSource.set(`${project.name}->${dep}`, `${project.dir || '.'}/package.json`);
    }
  }
}

for (const project of projects) {
  const declared = declaredDeps(project.pkg, DEP_SECTIONS);
  for (const abs of walk(project.abs, { accept: isSource, ignoreDirs: ignoredDirs })) {
    if (!inScope(abs)) continue;
    scanned++;
    const rel = toPosix(path.relative(ROOT, abs));
    const exemptTest = isExemptTestFile(rel);
    let specs: Spec[];
    try {
      specs = specsOfFile(abs);
    } catch (err) {
      report(rel, 1, `file could not be parsed (${err instanceof Error ? err.message : String(err)}).`, 'Fix the syntax error so imports can be verified.');
      continue;
    }

    for (const { spec: rawSpec, line } of specs) {
      const spec = rawSpec.replace(/[?#].*$/, '');
      if (spec === '') continue;

      if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
        const target = path.resolve(path.dirname(abs), spec);
        const into = path.relative(project.abs, target);
        if (into.startsWith('..') || path.isAbsolute(into)) {
          const owner = ownerOf(target);
          const shown = toPosix(path.relative(ROOT, target));
          const fix = owner && owner !== project
            ? `Import it by package name ("${owner.name}" via its public exports) and declare "${owner.name}" in ${project.dir}/package.json.`
            : 'Move the shared code into a workspace package and import it by package name (declared in package.json).';
          report(rel, line, `relative import "${rawSpec}" resolves outside its workspace (${project.dir}) to "${shown}".`, fix);
        }
        continue;
      }

      if (!spec.startsWith('/') && !spec.startsWith('#') && !spec.startsWith('@/') && !spec.startsWith('~/')) {
        const ext = externalForm(spec);
        for (const rule of exemptTest ? [] : externalRules) {
          if (!rule.workspaces.some((w) => matchesPattern(project, w))) continue;
          const hit = rule.forbid.find((g) => globMatch(g, ext));
          if (hit) {
            report(rel, line, `"${rawSpec}" is forbidden in workspace "${project.name}" by externalRules (matches "${hit}").`, 'Move this code to a workspace that may use the dependency (e.g. an adapter layer) and pass data in, or (human decision) edit guardrails.config.ts -> externalRules.');
          } else if (rule.allowOnly && !byName.has(ext.startsWith('@') ? ext.split('/').slice(0, 2).join('/') : ext.split('/')[0]) && !rule.allowOnly.some((g) => globMatch(g, ext))) {
            report(rel, line, `"${rawSpec}" is not in the allowOnly list of workspace "${project.name}" (${rule.allowOnly.join(', ') || 'empty'}).`, 'Remove the import or (human decision) extend externalRules.allowOnly.');
          }
        }
      }

      if (/^[a-zA-Z][\w+.-]*:/.test(spec) || spec.startsWith('/') || spec.startsWith('#') || spec.startsWith('@/') || spec.startsWith('~/')) continue;

      const parts = spec.split('/');
      const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const sub = spec.slice(pkgName.length); // '' or '/x/y'
      const target = byName.get(pkgName);
      if (target === project) continue;
      if (!target) {
        if (exemptTest) continue;
        const declaredHere = declared.has(pkgName) || (isTestOrConfigFile(rel) && rootDeclared.has(pkgName));
        if (
          !declaredHere && !isBuiltin(spec) && !pkgName.startsWith('@types/') && pkgName !== project.name &&
          !virtualModules.some((g) => globMatch(g, spec)) && !isAliased(spec) && resolveImport(abs, spec) === null
        ) {
          const key = `${project.name}\u0000${pkgName}`;
          const g = undeclared.get(key) ?? { project, pkgName, hits: [] };
          g.hits.push(`${rel}:${line}`);
          undeclared.set(key, g);
        }
        continue;
      }

      edges.get(project.name)!.add(target.name);
      if (!edgeSource.has(`${project.name}->${target.name}`)) edgeSource.set(`${project.name}->${target.name}`, `${rel}:${line}`);

      if (!declared.has(target.name) && !skipRules.includes('declared')) {
        report(
          rel, line,
          `imports workspace "${target.name}" but ${project.dir}/package.json does not declare it.`,
          `Add "${target.name}": "*" (or "workspace:*") to dependencies in ${project.dir}/package.json and run npm install.`
        );
      }

      const { ok, keys } = exportsAllows(target.pkg.exports, sub);
      if (!ok && !skipRules.includes('exports')) {
        const exposed = keys.length > 0 ? `exposed: ${keys.join(', ')}` : 'it has no "exports" map, so only the main entry is importable';
        report(
          rel, line,
          `"${spec}" is not a public entry of "${target.name}" (${exposed}).`,
          sub === ''
            ? `Add a "." entry to "exports" in ${target.dir}/package.json.`
            : `Import from the package root, or expose "./${sub.slice(1)}" (or a "./*" pattern) in "exports" of ${target.dir}/package.json.`
        );
      }

      if (layers && !skipRules.includes('layers')) {
        const from = layerOf.get(project.name);
        const to = layerOf.get(target.name);
        if (from !== undefined && to !== undefined && to >= from) {
          report(
            rel, line,
            `layer violation: "${project.name}" (${layers[from].name}) imports "${target.name}" (${layers[to].name}); only strictly lower layers may be imported.`,
            `Move the shared code down into a lower-layer package, invert the dependency, or (human decision) change guardrails.config.ts -> layers.`
          );
        }
      }
    }
  }
}

for (const { project, pkgName, hits } of undeclared.values()) {
  const [file, line] = hits[0].split(/:(\d+)$/);
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
  report(
    file, Number(line),
    `imports "${pkgName}" ${hits.length}x but ${project.dir}/package.json does not declare it (works only by hoisting accident); e.g. ${hits.slice(0, 3).join(', ')}${more}.`,
    `Add "${pkgName}" to dependencies in ${project.dir}/package.json (npm install ${pkgName} -w ${project.name}), or list it in guardrails.config.ts -> virtualModules (globs like "project/*") if it is a virtual module or bundler alias.`
  );
}

// ---------- devOnly layers: never a runtime dependency ----------
if (layers && !skipRules.includes('layers')) {
  for (const project of projects) {
    for (const dep of Object.keys({ ...(project.pkg.dependencies ?? {}), ...(project.pkg.optionalDependencies ?? {}) })) {
      const idx = layerOf.get(dep);
      const target = byName.get(dep);
      if (idx !== undefined && target && target !== project && layers[idx].devOnly) {
        report(`${project.dir || '.'}/package.json`, 1, `"${project.name}" depends on "${dep}" (devOnly layer "${layers[idx].name}") at runtime.`, `Move "${dep}" to devDependencies (or peerDependencies); devOnly layers are tooling/mocks that must not ship.`);
      }
    }
  }
}

// ---------- cycles (Tarjan SCC) ----------

{
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.reverse());
    }
  };
  for (const name of edges.keys()) if (!index.has(name)) strong(name);
  for (const comp of sccs) {
    const first = comp[0];
    const next = comp.find((c) => edges.get(first)!.has(c)) ?? comp[1];
    const where = edgeSource.get(`${first}->${next}`) ?? 'package.json';
    const [file, line] = where.split(/:(\d+)$/);
    report(
      file, Number(line ?? 1),
      `circular workspace dependency: ${[...comp, comp[0]].join(' -> ')}.`,
      'Break the cycle: extract the shared code into a new lower-level package or remove one dependency.'
    );
  }
}

// ---------- result ----------

if (scanned === 0 && !isDiffScoped) {
  report('.', 1, `scanned 0 source files in ${projects.length} workspace(s); the check would pass vacuously.`, 'Check guardrails.config.ts -> workspaces and importScanIgnoreDirs.');
}

if (findings.length > 0) {
  console.error(`\n❌ Workspace Boundary Check Failed (${findings.length} finding(s)):\n`);
  for (const f of findings) console.error(`  • ${f.file}:${f.line}  ${f.message}\n      fix: ${f.fix}`);
  console.error('');
  process.exit(1);
}
console.log(`✅ Workspace Boundaries Passed (${scanned} files${isDiffScoped ? ' in diff scope' : ''} across ${projects.length} workspace(s)${layers ? `, ${layers.length} layers` : ''}).`);
