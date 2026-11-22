#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * 1-Command Repository Guardrails Bootstrapper (scripts/bootstrap-repo.mjs)
 *
 * Usage:
 *   node scripts/bootstrap-repo.mjs --target /path/to/your-repo [--preset standard|storyblok] [--force] [--standalone] [--hooks]
 *   (--hooks writes .githooks/pre-push running the fast tier; enable with `git config core.hooksPath .githooks`)
 *
 * Single package: scripts live in `scripts/`. npm-workspaces monorepo (root package.json has `workspaces`):
 * bootstrap ONCE at the repo root; scripts live in `scripts/guardrails/` and every check iterates all workspaces.
 * Bootstrapping inside a workspace of a monorepo is refused unless `--standalone` is passed.
 */

// Everything the bootstrapper writes is normalised (no trailing whitespace, exactly one final newline) so that
// `git diff --check` stays clean on the generated files. JSON and .gitignore are left as written.
const rawWriteFileSync = fs.writeFileSync.bind(fs);
fs.writeFileSync = (file, data, ...rest) => {
  if (typeof data === 'string' && !/\.json$|(^|[\\/])\.gitignore$/.test(String(file))) {
    data = data.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
  }
  return rawWriteFileSync(file, data, ...rest);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const RESOURCES = path.join(SKILL_ROOT, 'resources');

// Annotation-free JS, so it loads without Node type stripping.
const { resolveWorkspaceGlobs, packageWorkspaceGlobs } = await import(
  'data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(RESOURCES, 'workspace-globs.ts'), 'utf8'))
);

const USAGE = 'Usage: node bootstrap-repo.mjs [--target <dir>] [--preset standard|storyblok] [--force] [--standalone] [--hooks] [--adopt] [--patch-agents] [--scaffold-specs]';
let cli;
try {
  cli = parseArgs({
    options: {
      target: { type: 'string' },
      preset: { type: 'string', default: 'standard' },
      force: { type: 'boolean', default: false },
      standalone: { type: 'boolean', default: false },
      hooks: { type: 'boolean', default: false },
      adopt: { type: 'boolean', default: false },
      'patch-agents': { type: 'boolean', default: false },
      'scaffold-specs': { type: 'boolean', default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  console.error(`❌ ${err.message}\n${USAGE}`);
  process.exit(1);
}

const targetDir = path.resolve(cli.target ?? process.cwd());
const preset = cli.preset.toLowerCase();
if (!['standard', 'storyblok'].includes(preset)) {
  console.error(`❌ Unknown preset "${cli.preset}". Use "standard" or "storyblok".`);
  process.exit(1);
}
const isStoryblok = preset === 'storyblok';
const force = cli.force;

const readJson = (file) => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const posix = (p) => p.split(path.sep).join('/');

// Validate existing manifests BEFORE writing anything, so a bad input never leaves a partial install.
const pkgPath = path.join(targetDir, 'package.json');
let pkg = null;
if (fs.existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`❌ ${pkgPath} is not valid JSON (${err.message}). Fix it and re-run; nothing was written.`);
    process.exit(1);
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    console.error(`❌ ${pkgPath} must contain a JSON object. Nothing was written.`);
    process.exit(1);
  }
  if (pkg.scripts !== undefined && (typeof pkg.scripts !== 'object' || pkg.scripts === null || Array.isArray(pkg.scripts))) {
    console.error(`❌ "scripts" in ${pkgPath} must be an object. Nothing was written.`);
    process.exit(1);
  }
}

// Refuse to bootstrap inside a workspace of a monorepo (the root owns the guardrails).
function findEnclosingMonorepoRoot(dir) {
  for (let cur = path.dirname(dir); cur !== path.dirname(cur); cur = path.dirname(cur)) {
    const globs = packageWorkspaceGlobs(readJson(path.join(cur, 'package.json')));
    if (!globs) continue;
    const rel = posix(path.relative(cur, dir));
    if (resolveWorkspaceGlobs(cur, globs).includes(rel)) return { root: cur, rel };
  }
  return null;
}
if (!cli.standalone) {
  const enclosing = findEnclosingMonorepoRoot(targetDir);
  if (enclosing) {
    console.error(
      `❌ ${targetDir} is the workspace "${enclosing.rel}" of the monorepo rooted at ${enclosing.root}.\n` +
        `   Guardrails are installed ONCE at the monorepo root and check every workspace:\n` +
        `     node ${path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'scripts/bootstrap-repo.mjs'} --target ${enclosing.root}\n` +
        `   Pass --standalone only if this directory must be guarded on its own. Nothing was written.`
    );
    process.exit(1);
  }
}

const workspaceGlobs = packageWorkspaceGlobs(pkg);
const isMonorepo = workspaceGlobs !== null && !cli.standalone;
let workspaces = []; // [{ dir, abs, name, pkg }]
if (isMonorepo) {
  for (const dir of resolveWorkspaceGlobs(targetDir, workspaceGlobs)) {
    const abs = path.join(targetDir, dir);
    const wpkg = readJson(path.join(abs, 'package.json'));
    if (!wpkg) {
      console.error(`❌ ${dir}/package.json is not valid JSON. Nothing was written.`);
      process.exit(1);
    }
    workspaces.push({ dir, abs, name: typeof wpkg.name === 'string' && wpkg.name ? wpkg.name : dir, pkg: wpkg });
  }
  if (workspaces.length === 0) {
    console.error(`❌ package.json "workspaces" (${JSON.stringify(workspaceGlobs)}) matches no directory with a package.json. Nothing was written.`);
    process.exit(1);
  }
  const names = new Map();
  for (const w of workspaces) {
    if (names.has(w.name)) {
      console.error(`❌ Workspaces "${names.get(w.name)}" and "${w.dir}" share the package name "${w.name}". Nothing was written.`);
      process.exit(1);
    }
    names.set(w.name, w.dir);
  }
}

// Auto-create target directory if it does not exist yet
fs.mkdirSync(targetDir, { recursive: true });

function copyIfMissingOrForce(srcRel, destRel, allowOverwrite = false, userOwned = false) {
  const srcPath = path.join(RESOURCES, srcRel);
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !allowOverwrite) {
    console.log(`⏭️  Skipped existing ${destRel}${userOwned ? ' (user-owned, never overwritten)' : ' (pass --force to overwrite)'}`);
    return false;
  }
  fs.writeFileSync(destPath, fs.readFileSync(srcPath, 'utf8'), 'utf8');
  console.log(`✅ Installed ${destRel}`);
  return true;
}

function writeIfMissingOrForce(destRel, content, allowOverwrite = false) {
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !allowOverwrite) {
    console.log(`⏭️  Skipped existing ${destRel}`);
    return false;
  }
  fs.writeFileSync(destPath, content, 'utf8');
  console.log(`✅ Created ${destRel}`);
  return true;
}

const allDeclared = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
const wsDeclared = (name) => workspaces.some((w) => name in { ...(w.pkg.dependencies ?? {}), ...(w.pkg.devDependencies ?? {}) });
const isAstroProject = isMonorepo
  ? workspaces.some((w) => 'astro' in { ...(w.pkg.dependencies ?? {}), ...(w.pkg.devDependencies ?? {}) } || fs.readdirSync(w.abs).some((f) => /^astro\.config\./.test(f)))
  : 'astro' in allDeclared || fs.readdirSync(targetDir).some((f) => /^astro\.config\./.test(f));

// ---------- 1. Core scripts, dependency-cruiser rules, config ----------
const SCRIPTS_DIR = isMonorepo ? 'scripts/guardrails' : 'scripts';
const CHECK_FILES = [
  'run-guardrails.ts',
  'git-changes.ts',
  'check-doc-drift.ts',
  'check-complexity.ts',
  'check-deps.ts',
  'check-arch.ts',
  'context.ts',
  'ts-api.ts',
  'ts-support.ts',
  'source-utils.ts',
  'doc-claims.ts',
  'workspace-globs.ts',
  'request-reads.ts',
  'cache-headers.ts',
  'resolve-import.ts',
  'interactive.ts',
  'weakened.ts',
  'check-caching.ts',
  'scope.ts',
  'defaults.ts',
  'check-gate.ts',
  'layers-file.ts',
  ...(isMonorepo ? ['check-imports.ts'] : []),
  ...(isMonorepo || isAstroProject ? ['check-ssr.ts'] : []),
];

/** Topological layers inferred from the declared workspace dependency graph (null when not meaningful). */
function inferLayers() {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const isApp = (w) => w.dir.startsWith('apps/');
  const depsOf = (w) =>
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((s) =>
      Object.keys(w.pkg[s] ?? {}).filter((n) => byName.has(n) && n !== w.name)
    );
  for (const w of workspaces) {
    for (const d of depsOf(w)) {
      if (isApp(byName.get(d))) return null; // something depends on an app: not a clean layering
    }
  }
  const level = new Map();
  const visiting = new Set();
  let cyclic = false;
  const lvl = (w) => {
    if (level.has(w.name)) return level.get(w.name);
    if (visiting.has(w.name)) {
      cyclic = true;
      return 0;
    }
    visiting.add(w.name);
    const l = depsOf(w).reduce((m, d) => Math.max(m, lvl(byName.get(d)) + 1), 0);
    visiting.delete(w.name);
    level.set(w.name, l);
    return l;
  };
  const libs = workspaces.filter((w) => !isApp(w));
  const apps = workspaces.filter(isApp);
  libs.forEach(lvl);
  if (cyclic) return null;
  const layers = [];
  for (const w of libs) (layers[level.get(w.name)] ??= { name: `layer-${level.get(w.name)}`, workspaces: [] }).workspaces.push(w.dir);
  const result = layers.filter(Boolean);
  if (apps.length > 0) result.push({ name: 'apps', workspaces: apps.map((a) => a.dir) });
  return result.length >= 2 ? result : null;
}
// ---------- 0. Existing guardrails (adopt mode) ----------
const summary = []; // [item, status]
const exists = (rel) => fs.existsSync(path.join(targetDir, rel));
const listDir = (rel) => { try { return fs.readdirSync(path.join(targetDir, rel)); } catch { return []; } };
const existingGuards = {
  guardScripts: listDir('scripts').filter((f) => /^guard.*\.[cm]?[jt]s$/.test(f)).map((f) => `scripts/${f}`),
  claimTests: listDir('scripts').filter((f) => /doc-claims|boundar/.test(f) && /\.[cm]?[jt]s$/.test(f)).map((f) => `scripts/${f}`),
  verifyScript: typeof pkg?.scripts?.verify === 'string',
  husky: exists('.husky'),
  nonGithubCi: ['Jenkinsfile', '.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml'].filter(exists),
  layersFile: ['scripts/module-layers.json', 'module-layers.json', 'docs/module-layers.json'].find(exists),
  adrs: ['docs/adr', 'docs/decisions'].filter((d) => listDir(d).some((f) => f.endsWith('.md'))),
};
const hasExistingGuards = existingGuards.guardScripts.length + existingGuards.claimTests.length > 0 || existingGuards.layersFile || existingGuards.verifyScript || existingGuards.husky || existingGuards.nonGithubCi.length > 0;
if (hasExistingGuards) {
  const found = [
    ...existingGuards.guardScripts, ...existingGuards.claimTests,
    ...(existingGuards.layersFile ? [existingGuards.layersFile] : []),
    ...(existingGuards.verifyScript ? ['package.json "verify" script'] : []),
    ...(existingGuards.husky ? ['.husky hooks'] : []),
    ...existingGuards.nonGithubCi,
  ];
  console.log(`ℹ️  Existing enforcement detected: ${found.join(', ')}. Nothing of it is edited or duplicated.`);
}

/** Validates an existing layers file with the same shapes as resources/layers-file.ts (annotation-free copy). */
function layersFileValid(rel) {
  const raw = readJson(path.join(targetDir, rel));
  if (!raw) return false;
  const isStr = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
  let list = 'layers' in raw ? raw.layers : raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) list = Object.entries(list).filter(([k]) => !k.startsWith('_')).map(([name, v]) => (isStr(v) ? { name, workspaces: v } : v));
  return Array.isArray(list) && list.length > 0 && list.every((e) => isStr(e) || (e && typeof e === 'object' && (isStr(e.workspaces) || isStr(e.members) || isStr(e.packages))));
}
let layersFile = null;
if (isMonorepo && existingGuards.layersFile) {
  if (layersFileValid(existingGuards.layersFile)) layersFile = existingGuards.layersFile;
  else console.warn(`⚠️  ${existingGuards.layersFile} has an unknown layers shape; not used. Accepted: { layers: [{ name, workspaces|members|packages, devOnly? }] }, { layers: [[...]] } or { name: [...] }. Falling back to inferred layers.`);
}
// --adopt: skip import rules that existing tests/scripts already enforce (reported by the runner only when no reason is given)
const overlapFiles = [...existingGuards.guardScripts, ...existingGuards.claimTests];
const skipImportRules = isMonorepo && cli.adopt && overlapFiles.length > 0 ? ['layers', 'exports', 'declared'] : [];
const layers = isMonorepo && !layersFile ? inferLayers() : null;

const q = (arr) => `[${arr.map((x) => `'${x}'`).join(', ')}]`;

function monorepoConfigText() {
  let cfg = fs.readFileSync(path.join(RESOURCES, 'guardrails.config.ts'), 'utf8');
  const patch = (from, to) => {
    if (!cfg.includes(from)) {
      console.error(`❌ Internal error: could not generate the monorepo config (pattern not found: ${from.trim().slice(0, 50)}).`);
      process.exit(1);
    }
    cfg = cfg.replace(from, () => to);
  };
  const layersText = layersFile
    ? `  layersFile: '${layersFile}', // existing layers file, read instead of a copy (devOnly tiers may only be devDependencies)\n`
    : layers
    ? `  layers: [\n${layers.map((l) => `    { name: '${l.name}', workspaces: ${q(l.workspaces)} },`).join('\n')}\n  ],\n`
    : '';
  const pureDirs = workspaces
    .filter((w) => /^(domain|core|shared-types|types|utils)$/.test(path.basename(w.dir)) || /(^|\/)(domain|core|shared-types|types|utils)$/.test(w.name))
    .map((w) => w.dir);
  const externalText = pureDirs.length > 0
    ? `  // Pure packages stay free of runtime-specific specifiers. Edit as needed (weakening is reported by the runner).\n  // To also keep a CMS SDK out of a package, add e.g. forbid: ['@storyblok/*'] (not a default: mapper/CMS packages may import it).\n  externalRules: [\n    { workspaces: ${q(pureDirs)}, forbid: ['node:*', 'cloudflare:*', 'astro:*'] },\n  ],\n`
    : '';
  patch(
    "  scopedModules: ['src/domain', 'src/worker', 'src/ui'],\n",
    `  // Monorepo mode: workspace globs from the root package.json. Every check iterates all workspaces.\n  workspaces: ${q(workspaceGlobs)},\n` +
      `  // Layers low -> high: a workspace may import only from strictly lower layers (see check:imports).\n${layersText || '  // layers: [{ name: \'base\', workspaces: [\'packages/*\'] }, { name: \'apps\', workspaces: [\'apps/*\'] }],\n'}` +
      externalText +
      (skipImportRules.length > 0 ? `  // --adopt: these rules are already enforced by ${overlapFiles.join(', ')}\n  skipImportRules: ${q(skipImportRules)},\n  skipImportRulesReason: 'enforced by ${overlapFiles[0]}',\n` : '') +
      `  scopedModules: [], // per-workspace folders that carry their own AGENTS.md, e.g. ['src/domain']\n` +
      `  requireTests: true, // set false to accept a monorepo without any \`test\` script\n  requireInteractiveSpecs: true,\n  requireAdr: true,\n`
  );
  patch("extraComplexityScanDirs: ['src/pages', 'public'],", "extraComplexityScanDirs: ['src', 'public'],");
  patch(
    "uiTriggerPatterns: [/^src\\/ui\\//, /^src\\/storyblok\\//, /^src\\/pages\\/index\\.astro$/, /(^|\\/)src\\/.*\\.astro$/, /^tests\\//, /(^|\\/)src\\/.*(session|auth|cookie|middleware|mapper)/i],",
    "uiTriggerPatterns: [/(^|\\/)src\\/(ui|storyblok|components)\\//, /\\.astro$/, /(^|\\/)tests?\\//, /(^|\\/)src\\/.*(session|auth|cookie|middleware|mapper)/i],"
  );
  patch("globalLayoutAstroPath: 'src/pages/index.astro',", 'globalLayoutAstroPath: null,');
  if (isStoryblok) {
    patch(
      '  scopedModules: [], // per-workspace',
      "  storyblok: { wrapperDir: 'src/storyblok', requireStoryblokEditable: true }, // checked in every workspace that has it\n  scopedModules: [], // per-workspace"
    );
  }
  return cfg;
}

let installedConfig;
const configPath = path.join(targetDir, 'guardrails.config.ts');
const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
if (force && previousConfig !== null) {
  fs.writeFileSync(`${configPath}.bak`, previousConfig, 'utf8');
  console.log('ℹ️  --force: previous guardrails.config.ts saved as guardrails.config.ts.bak');
}
if (isMonorepo) {
  installedConfig = writeIfMissingOrForce('guardrails.config.ts', monorepoConfigText(), force);
  if (!installedConfig && !fs.readFileSync(path.join(targetDir, 'guardrails.config.ts'), 'utf8').includes('workspaces')) {
    console.warn('⚠️  Existing guardrails.config.ts has no `workspaces` key, so it runs in single-package mode. Add `workspaces: [...]` or re-run with --force.');
  }
} else {
  installedConfig = copyIfMissingOrForce('guardrails.config.ts', 'guardrails.config.ts', force);
}
if (installedConfig && force && previousConfig !== null) {
  // an existing visual spec must stay wired: never reset visualSpecPath on --force
  const prev = previousConfig.match(/^\s*visualSpecPath:\s*(['"`][^'"`]+['"`])/m)?.[1];
  if (prev && fs.existsSync(path.join(targetDir, prev.slice(1, -1)))) {
    const fresh = fs.readFileSync(configPath, 'utf8');
    if (/visualSpecPath:\s*null/.test(fresh)) {
      fs.writeFileSync(configPath, fresh.replace(/visualSpecPath:\s*null/, `visualSpecPath: ${prev}`), 'utf8');
      console.log(`ℹ️  --force: kept visualSpecPath ${prev}`);
    }
  }
}
for (const f of CHECK_FILES) copyIfMissingOrForce(f, `${SCRIPTS_DIR}/${f}`, force);
copyIfMissingOrForce('dependency-cruiser.cjs', '.dependency-cruiser.cjs', force);

// Storyblok preset (single package): five scoped modules and the storyblok block
if (isStoryblok && !isMonorepo && !installedConfig) {
  console.warn("⚠️  Existing guardrails.config.ts kept: add the Storyblok scopedModules and `storyblok` block manually (see README), or re-run with --force.");
} else if (isStoryblok && !isMonorepo) {
  const cfgPath = path.join(targetDir, 'guardrails.config.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  const patched = cfg.replace(
    "scopedModules: ['src/domain', 'src/worker', 'src/ui'],",
    "scopedModules: ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker'],\n  storyblok: {\n    wrapperDir: 'src/storyblok',\n    requireStoryblokEditable: true,\n  },"
  );
  if (patched === cfg && !cfg.includes("'src/storyblok'")) {
    console.error('❌ Could not apply the storyblok preset: scopedModules line not found in guardrails.config.ts.');
    process.exit(1);
  }
  fs.writeFileSync(cfgPath, patched, 'utf8');
  console.log('✅ Configured guardrails.config.ts for Storyblok preset');
}

// ---------- 2. tsconfig: keep guardrail scripts out of the runtime typecheck ----------
const tsconfigPath = path.join(targetDir, 'tsconfig.json');
if (fs.existsSync(tsconfigPath)) {
  const manual = 'add "scripts", "guardrails.config.ts", "playwright.config.ts" and "tests" to its "exclude" manually.';
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  } catch {
    console.warn(`⚠️  tsconfig.json contains comments/trailing commas and was not modified; ${manual}`);
  }
  if (parsed && !Array.isArray(parsed.exclude) && parsed.extends) {
    console.warn(`⚠️  tsconfig.json extends another config and has no own "exclude"; not modified (it would replace the inherited list); ${manual}`);
  } else if (parsed) {
    const exclude = new Set(Array.isArray(parsed.exclude) ? parsed.exclude : ['dist', 'node_modules']);
    const before = exclude.size;
    for (const entry of ['scripts', 'guardrails.config.ts', 'playwright.config.ts', 'tests']) exclude.add(entry);
    if (exclude.size !== before) {
      parsed.exclude = Array.from(exclude);
      fs.writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log('✅ Updated tsconfig.json exclude list to isolate Node CLI scripts from Worker runtime types');
    }
  }
}

const WRANGLER = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const hasWrangler = [targetDir, ...(isMonorepo ? workspaces.map((w) => w.abs ?? path.join(targetDir, w.dir)) : [])].some((d) => WRANGLER.some((f) => fs.existsSync(path.join(d, f))));

// ---------- 3. package.json scripts (never overwrite existing ones; no dead scripts) ----------
const strip = (f) => `node --experimental-strip-types ${SCRIPTS_DIR}/${f}`;
const GUARDRAIL_SCRIPTS = {
  'check:arch': strip('check-arch.ts'),
  'check:drift': strip('check-doc-drift.ts'),
  'check:complexity': strip('check-complexity.ts'),
  'check:deps': strip('check-deps.ts'),
  ...(isMonorepo ? { 'check:imports': strip('check-imports.ts') } : {}),
  ...(isMonorepo || isAstroProject ? { 'check:ssr': strip('check-ssr.ts') } : {}),
  'check:caching': strip('check-caching.ts'),
  ...(hasWrangler ? { 'check:gate': strip('check-gate.ts') } : {}),
  guardrails: strip('run-guardrails.ts'),
};
const hasPlaywright =
  '@playwright/test' in allDeclared ||
  (isMonorepo && wsDeclared('@playwright/test')) ||
  fs.readdirSync(targetDir).some((f) => /^playwright\.config\./.test(f));
const rootPlaywrightConfig = fs.readdirSync(targetDir).some((f) => /^playwright\.config\./.test(f));
// a root check:visual only when a root Playwright config exists (a workspace's config is run by the runner in that directory)
if (hasPlaywright && (!isMonorepo || rootPlaywrightConfig)) GUARDRAIL_SCRIPTS['check:visual'] = 'playwright test';

/** Playwright configs anywhere (root or a workspace) and the spec glob each one points at. */
function findPlaywright() {
  const out = [];
  for (const base of [{ dir: '', abs: targetDir }, ...(isMonorepo ? workspaces.map((w) => ({ dir: w.dir, abs: w.abs })) : [])]) {
    let files = [];
    try { files = fs.readdirSync(base.abs).filter((f) => /^playwright\.config\.[cm]?[jt]s$/.test(f)); } catch {}
    for (const f of files) {
      const text = fs.readFileSync(path.join(base.abs, f), 'utf8');
      const testDir = text.match(/testDir:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? '.';
      const rel = path.posix.normalize(`${base.dir}/${testDir}`).replace(/^\.\/?/, '').replace(/\/$/, '');
      const hasSpecs = (() => { const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? e.name !== 'node_modules' && walk(path.join(d, e.name)) : /\.spec\.[cm]?[jt]sx?$/.test(e.name))); } catch { return false; } }; return walk(path.join(targetDir, rel)); })();
      out.push({ config: `${base.dir ? base.dir + '/' : ''}${f}`, glob: `${rel ? rel + '/' : ''}**/*.spec.*`, hasSpecs });
    }
  }
  return out;
}
const playwrightFound = findPlaywright();
const hasPlaywrightAnywhere = hasPlaywright || playwrightFound.length > 0;

const manifest = pkg ?? { name: path.basename(targetDir), private: true, type: 'module' };
manifest.scripts = manifest.scripts ?? {};

const notes = [];
const reusedCheck = ['check', 'typecheck', 'check:types'].find((n) => typeof manifest.scripts[n] === 'string' && !/guardrails/.test(manifest.scripts[n]));
const hasTypecheckScript = 'check:types' in manifest.scripts || 'typecheck' in manifest.scripts || reusedCheck !== undefined;
if (reusedCheck && !('check:types' in manifest.scripts) && !('typecheck' in manifest.scripts)) {
  notes.push(`Root \`${reusedCheck}\` script exists: no second \`check:types\` chain was generated; the runner uses \`npm run ${reusedCheck}\` as the type gate.`);
  summary.push(['check:types', `skipped (reuses root "${reusedCheck}")`]);
}
if (!isMonorepo) {
  if (fs.existsSync(tsconfigPath) && !hasTypecheckScript) {
    if (isAstroProject && ('@astrojs/check' in allDeclared || fs.existsSync(path.join(targetDir, 'node_modules/@astrojs/check')))) {
      GUARDRAIL_SCRIPTS['check:types'] = 'astro check && tsc --noEmit';
    } else if (isAstroProject) {
      notes.push('No check:types script installed: plain `tsc` reports TS2307 on .astro imports and `astro check` needs @astrojs/check. Run: npm install -D @astrojs/check typescript   then re-run the bootstrapper (it adds `astro check && tsc --noEmit`).');
    } else {
      GUARDRAIL_SCRIPTS['check:types'] = 'tsc --noEmit';
    }
  } else if (!fs.existsSync(tsconfigPath) && !hasTypecheckScript) {
    notes.push('No tsconfig.json: no `check:types` script was installed (add one with a tsconfig, e.g. `tsc --noEmit`).');
  }
} else {
  const untyped = workspaces.filter(
    (w) => fs.existsSync(path.join(w.abs, 'tsconfig.json')) && !('check:types' in (w.pkg.scripts ?? {})) && !('typecheck' in (w.pkg.scripts ?? {}))
  );
  const hasAstroFiles = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? e.name !== 'node_modules' && !e.name.startsWith('.') && hasAstroFiles(path.join(dir, e.name)) : e.name.endsWith('.astro')));
    } catch {
      return false;
    }
  };
  const astroWs = untyped.length > 0 || workspaces.length > 0 ? workspaces.filter((w) => (hasAstroFiles(path.join(w.abs, 'src')) || 'astro' in { ...(w.pkg.dependencies ?? {}), ...(w.pkg.devDependencies ?? {}) }) && !('check:types' in (w.pkg.scripts ?? {})) && !('typecheck' in (w.pkg.scripts ?? {}))) : [];
  const hasAstroCheck = '@astrojs/check' in allDeclared || wsDeclared('@astrojs/check') || fs.existsSync(path.join(targetDir, 'node_modules/@astrojs/check'));
  const tsOnly = workspaces.filter((w) => fs.existsSync(path.join(w.abs, 'tsconfig.json')) && !astroWs.includes(w) && !('check:types' in (w.pkg.scripts ?? {})) && !('typecheck' in (w.pkg.scripts ?? {})));
  if (!hasTypecheckScript && hasAstroCheck && (astroWs.length > 0 || tsOnly.length > 0)) {
    GUARDRAIL_SCRIPTS['check:types'] = [...astroWs.map((w) => `astro check --root ${w.dir}`), ...tsOnly.map((w) => `tsc --noEmit -p ${w.dir}`)].join(' && ');
  } else if (astroWs.length > 0 && !hasTypecheckScript) {
    notes.push(`.astro files in ${astroWs.map((w) => w.dir).join(', ')} are never type-checked, and no check:types script was installed (plain tsc reports TS2307 on .astro imports). Run: npm install -D @astrojs/check typescript   then re-run the bootstrapper (it adds a root \`check:types\`: \`astro check --root <app>\` per Astro app, \`tsc --noEmit -p <ws>\` for the rest).`);
  } else if (untyped.length > 0 && !hasTypecheckScript) {
    notes.push(`No type-check script in: ${untyped.map((w) => w.dir).join(', ')} (they have a tsconfig). Add a "check:types" script to each (Astro: \`astro check\` with @astrojs/check; plain TS: \`tsc --noEmit\`); the runner executes it in every workspace.`);
  }
  if (!workspaces.some((w) => 'test' in (w.pkg.scripts ?? {})) && !('test' in manifest.scripts)) {
    notes.push('No `test` script in the root or any workspace: `npm run guardrails` FAILS until one exists. Add tests, or set `requireTests: false` in guardrails.config.ts to opt out.');
  }
  if (!workspaces.some((w) => 'build' in (w.pkg.scripts ?? {})) && !('build' in manifest.scripts)) {
    notes.push('No `build` script found; the runner will skip the build gate.');
  }
}

const added = [];
for (const [name, cmd] of Object.entries(GUARDRAIL_SCRIPTS)) {
  if (!(name in manifest.scripts)) {
    manifest.scripts[name] = cmd;
    added.push(name);
  } else if (manifest.scripts[name] !== cmd) {
    console.warn(`⚠️  package.json script "${name}" already exists and differs from the guardrail default; kept yours. Expected: ${cmd}`);
  }
}
if (added.length > 0 || !pkg) {
  fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
console.log(
  pkg
    ? added.length ? `✅ Added package.json scripts: ${added.join(', ')}` : '⏭️  package.json scripts already present'
    : `✅ Created package.json with guardrail scripts: ${added.join(', ')}`
);
if (pkg && pkg.type !== 'module') {
  console.warn(`ℹ️  package.json has no "type": "module"; Node prints a reparse warning for ${SCRIPTS_DIR}/*.ts. Add it if your project allows.`);
}

// ---------- 4. Root context router, CLAUDE.md bridge, Copilot instructions, ADR ----------
const scriptExists = (name) => name in manifest.scripts;
/** Drops template lines that mention commands/paths which do not exist in this repo. */
function pruneTemplate(text) {
  return text
    .split('\n')
    .filter((line) => {
      for (const m of line.matchAll(/`npm run ([\w:.-]+)`/g)) if (!scriptExists(m[1])) return false;
      if (/^\|\s*`public\/`/.test(line) && !fs.existsSync(path.join(targetDir, 'public'))) return false;
      return true;
    })
    .join('\n');
}

const cell = (s) => String(s ?? '').replace(/[`|<>{}]/g, '').replace(/\s+/g, ' ').trim();

function monorepoAgentsMd() {
  const rows = workspaces.map((w) => {
    const readme = fs.existsSync(path.join(w.abs, 'README.md'));
    const purpose = cell(w.pkg.description) || (w.dir.startsWith('apps/') ? 'Deployable application' : 'Shared package');
    return `| \`${w.dir}/\` | ${cell(w.name)} | ${purpose} | \`${w.dir}/${readme ? 'README.md' : 'package.json'}\` | \`docs/adr/0001-workspace-boundaries.md\` |`;
  });
  const optional = ['dev', 'build', 'test', 'check:types'].filter(scriptExists).map((s) => `- **\`npm run ${s}\`** (root script)`);
  const layerText = layers
    ? `\n## 3. Layers (low → high)\nA workspace may import only from strictly lower layers; same-layer imports are errors.\n\n${layers.map((l, i) => `${i + 1}. ${l.name}: ${l.workspaces.map((d) => `\`${d}/\``).join(', ')}`).join('\n')}\n`
    : '';
  return `# Agent Context Router

> **READ FIRST:** This file is a routing index for an npm-workspaces monorepo. Do **not** read every workspace upfront. Open only the context file of the workspace you are changing and the ADR below.

## 1. Quick Commands
- **Run All Guardrails (MANDATORY before finishing a task):** \`npm run guardrails\`
- **Against a base ref (CI / PR):** \`npm run guardrails -- --base origin/main\` (the \`--\` is required so npm forwards the flag)
- **Single checks:** \`npm run check:imports\` (workspace boundaries), \`npm run check:arch\`, \`npm run check:drift\`, \`npm run check:complexity\`, \`npm run check:deps\`, \`npm run check:caching\`${scriptExists('check:ssr') ? ', `npm run check:ssr`' : ''}
${optional.join('\n')}

## 2. Workspace Routing Table
| Workspace | Package | Responsibility | Context File | Governing ADR |
| :--- | :--- | :--- | :--- | :--- |
${rows.join('\n')}
${layerText}
## ${layers ? '4' : '3'}. Non-Negotiable Rules
1. **Respect Workspace Boundaries:** import another workspace only by its package name, declare it in your package.json, and use only paths its \`exports\` expose (no deep \`src/\` imports, no relative paths into another workspace).
2. **Keep Docs in Sync with Code:** every path and \`npm run\` command written in an AGENTS.md or README.md must exist; \`npm run guardrails\` fails otherwise.
3. **Record Architectural Changes:** changing dependency directions or layers needs an ADR in \`docs/adr/\` first.
`;
}

function monorepoAdr() {
  const lines = workspaces.map((w) => `  - ${w.dir}`).join('\n');
  const layerText = layers
    ? layers.map((l, i) => `${i + 1}. **${l.name}**: ${l.workspaces.join(', ')}`).join('\n')
    : layersFile
    ? `Layers (low to high) are read from \`${layersFile}\`.`
    : 'No layers are configured; add `layers` to guardrails.config.ts to enforce a direction.';
  return `---
id: ADR-0001
title: Workspace Boundaries
status: accepted
applies_to:
${lines}
enforced_by: ${SCRIPTS_DIR}/check-imports.ts
---

# ADR-0001: Workspace Boundaries

## Context
Workspaces of this monorepo are separate packages. Reaching into another workspace through relative paths or \`src/\` internals couples them and breaks independent builds.

## Decision
- A workspace imports another workspace only by package name, declared in its package.json.
- Imports must go through the target's \`exports\` map; deep \`src/\` imports are forbidden.
- Layers (low to high); a workspace may only depend on strictly lower layers:

${layerText}

- Circular workspace dependencies are forbidden.

## Enforcement
\`npm run check:imports\` fails on every violation with file, line and fix.
`;
}

if (isMonorepo) {
  writeIfMissingOrForce('AGENTS.md', monorepoAgentsMd(), false);
} else {
  const rootTemplate = isStoryblok ? 'templates/AGENTS.storyblok.md' : 'templates/AGENTS.root.md';
  writeIfMissingOrForce('AGENTS.md', pruneTemplate(fs.readFileSync(path.join(RESOURCES, rootTemplate), 'utf8')), false);
}
if (cli['patch-agents']) {
  const ap = path.join(targetDir, 'AGENTS.md');
  const cur = fs.readFileSync(ap, 'utf8');
  if (/npm run guardrails/.test(cur)) console.log('⏭️  AGENTS.md already mentions `npm run guardrails`');
  else {
    fs.writeFileSync(ap, cur.replace(/\n*$/, '\n') + '\n- **Guardrails:** `npm run guardrails` (run before finishing a task)\n', 'utf8');
    console.log('✅ --patch-agents: appended one guardrails line to AGENTS.md');
  }
}
writeIfMissingOrForce('CLAUDE.md', '@AGENTS.md\n', false);
writeIfMissingOrForce(
  '.github/copilot-instructions.md',
  'Read and follow [AGENTS.md](../AGENTS.md) as the authoritative context router and guardrail specification for this repository.\n',
  false
);

if (isMonorepo) {
  if (existingGuards.adrs.length > 0) {
    console.log(`⏭️  Existing decision records in ${existingGuards.adrs.join(', ')}: ADR-0001 not generated (requireAdr is satisfied by those).`);
    summary.push(['ADR-0001', `skipped (existing ${existingGuards.adrs[0]}/)`]);
  } else {
    writeIfMissingOrForce('docs/adr/0001-workspace-boundaries.md', monorepoAdr(), false);
  }
} else {
  const adrPath = path.join(targetDir, 'docs/adr/0001-layered-modular-boundaries.md');
  if (!fs.existsSync(adrPath)) {
    let adrContent = fs.readFileSync(path.join(RESOURCES, 'templates/0001-layered-modular-boundaries.md'), 'utf8');
    if (isStoryblok) {
      const patchedAdr = adrContent.replace(
        '  - src/domain\n  - src/ui\n  - src/worker\n  - src/pages',
        '  - src/domain\n  - src/cms\n  - src/storyblok\n  - src/ui\n  - src/worker\n  - src/pages'
      );
      if (patchedAdr === adrContent) {
        console.warn('⚠️  ADR applies_to list not patched for the storyblok preset; edit it manually.');
      }
      adrContent = patchedAdr;
    }
    writeIfMissingOrForce('docs/adr/0001-layered-modular-boundaries.md', adrContent, false);
  }
}

// ---------- 5. Scoped AGENTS.md starters (single package only; monorepo workspaces own their docs) ----------
const SCOPED_DESCRIPTIONS = {
  'src/domain': {
    title: 'Domain Layer Context (`src/domain/`)',
    purpose: 'Pure TypeScript domain models, view-models, and shared contracts.',
    constraints:
      '- **ALLOWED imports:** Only files within `src/domain/`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/cms/*`, `src/worker/*`, `src/pages/*`, or external runtime SDKs.',
  },
  'src/cms': {
    title: 'CMS Anti-Corruption Layer Context (`src/cms/`)',
    purpose:
      'Fetches CMS stories, parses `_editable` comments, and maps raw CMS bloks into pure `src/domain/` view models.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/cms/*`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/worker/*`, or `src/pages/*`.',
  },
  'src/storyblok': {
    title: 'Storyblok Wrapper Layer Context (`src/storyblok/`)',
    purpose:
      'Thin `.astro` blok wrapper components that attach `storyblokEditable(blok)` and delegate presentation to `src/ui/`.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*`, `src/cms/*`, `src/ui/*`, and `src/storyblok/*`.\n- **FORBIDDEN imports:** `src/worker/*` or `src/pages/*`.\n- Every wrapper component MUST call `storyblokEditable(blok)`.',
  },
  'src/ui': {
    title: 'UI Presentation Layer Context (`src/ui/`)',
    purpose:
      'Pure design-system presentation components and client controllers decoupled from CMS and Edge Worker internals.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/ui/*`.\n- **FORBIDDEN imports:** `src/worker/*`, `src/cms/*`, `src/storyblok/*`, or `src/pages/*`.\n- **SSR Purity:** Modules imported in `.astro` SSR frontmatter (`---`) must be 100% isomorphic (no `document`, `window`, `navigator`, `HTMLElement`).',
  },
  'src/worker': {
    title: 'Edge Worker Layer Context (`src/worker/`)',
    purpose:
      'Encapsulates Cloudflare Worker / Edge runtime bindings, preview detection, PoP metadata, and cache policy computation.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/worker/*`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/cms/*`, or `src/pages/*`.',
  },
};

if (!isMonorepo) {
  const activeModules = isStoryblok
    ? ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker']
    : ['src/domain', 'src/worker', 'src/ui'];
  for (const mod of activeModules) {
    const meta = SCOPED_DESCRIPTIONS[mod];
    const modAgentsMd = `# ${meta.title}\n\n## Purpose\n${meta.purpose}\n\n## Constraints (Enforced by \`npm run guardrails\`)\n${meta.constraints}\n\n## Exported Modules\n<!-- check-doc-drift verifies every .ts/.astro file in this directory is listed below -->\n`;
    writeIfMissingOrForce(`${mod}/AGENTS.md`, modAgentsMd, false);
  }
  fs.mkdirSync(path.join(targetDir, 'src/pages'), { recursive: true });
}

// ---------- 5b. Keep the runner's result cache out of git ----------
{
  const giPath = path.join(targetDir, '.gitignore');
  const current = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (!/^\/?\.guardrails-cache\/?\s*$/m.test(current)) {
    fs.writeFileSync(giPath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.guardrails-cache/\n`);
    console.log('✅ Added .guardrails-cache/ to .gitignore');
  }
}

// ---------- 5a. Interactive .astro files need a Playwright spec ----------
{
  const roots = isMonorepo ? workspaces.map((w) => w.abs ?? path.join(targetDir, w.dir)) : [targetDir];
  const hits = [];
  const walkAstro = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', '.astro', '.wrangler'].includes(e.name)) walkAstro(f); }
      else if (e.name.endsWith('.astro')) {
        const t = fs.readFileSync(f, 'utf8').replace(/^\s*---\n[\s\S]*?\n---/, '').replace(/<!--[\s\S]*?-->/g, '');
        if (/<script\b(?![^>]*type\s*=\s*["']?(application\/(ld\+)?json|importmap|speculationrules))|\bclient:(load|idle|visible|media|only)\b/i.test(t)) hits.push(path.relative(targetDir, f).split(path.sep).join('/'));
      }
    }
  };
  for (const r of roots) walkAstro(path.join(r, 'src'));
  if (hits.length > 0) {
    const cfgPath = path.join(targetDir, 'guardrails.config.ts');
    const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    const wired = fs.existsSync(cfgPath) && !/visualSpecPath:\s*null/.test(cfg);
    const existingSpecs = playwrightFound.find((p) => p.hasSpecs);
    if (wired) {
      // already wired by the user
    } else if (existingSpecs && fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, cfg.replace(/visualSpecPath:\s*null/, `visualSpecPath: '${existingSpecs.glob}'`), 'utf8');
      notes.push(`Interactive .astro files found (${hits.length}): visualSpecPath wired to the existing Playwright specs (${existingSpecs.glob}, from ${existingSpecs.config}). check:drift reports selectors those specs do not cover.`);
      summary.push(['visualSpecPath', `wired to ${existingSpecs.glob}`]);
    } else if (cli['scaffold-specs'] && hasPlaywrightAnywhere && fs.existsSync(cfgPath)) {
      const body = hits.map((h) => `test.fixme('${h}: covers its interactive behaviour', async ({ page }) => {\n  // Open a page that renders ${h}, then assert on its selectors (data-testid, ids, classes).\n  await page.goto('/');\n});\n`).join('\n');
      writeIfMissingOrForce('tests/interactive.spec.ts', `import { test } from '@playwright/test';\n\n${body}`, false);
      fs.writeFileSync(cfgPath, cfg.replace(/visualSpecPath:\s*null/, "visualSpecPath: 'tests/interactive.spec.ts'"), 'utf8');
      notes.push(`Interactive .astro files found (${hits.length}): scaffolded tests/interactive.spec.ts (--scaffold-specs) and set visualSpecPath. Fill in the tests.`);
    } else {
      notes.push(`Interactive .astro files found (${hits.length}, e.g. ${hits[0]}): add a Playwright spec and set visualSpecPath (a file, glob or array) in guardrails.config.ts; until then \`guardrails\` reports a weakened-config failure. Starter: re-run with --scaffold-specs (needs @playwright/test).`);
    }
  }
}

// ---------- 5c. CI workflow and optional pre-push hook ----------
{
  const wfDir = path.join(targetDir, '.github/workflows');
  const wfPath = path.join(wfDir, 'guardrails.yml');
  const existing = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  const visualConfigured = hasPlaywrightAnywhere || /visualSpecPath:\s*['"`]/.test(fs.existsSync(path.join(targetDir, 'guardrails.config.ts')) ? fs.readFileSync(path.join(targetDir, 'guardrails.config.ts'), 'utf8') : '');
  const workflowText = (withPlaywright) => `name: guardrails
on:
  pull_request:
  push:
    branches: [main, master]
jobs:
  guardrails:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
${withPlaywright ? '      - run: npx playwright install --with-deps chromium\n' : ''}      - run: npm run guardrails -- --all
`;
  if (fs.existsSync(wfPath) && !force) {
    const current = fs.readFileSync(wfPath, 'utf8').replace(/\r\n/g, '\n');
    if (current === workflowText(false) && visualConfigured) {
      fs.writeFileSync(wfPath, workflowText(true), 'utf8');
      console.log('✅ Updated .github/workflows/guardrails.yml: added the Playwright install step (the visual gate is configured)');
    } else if (current !== workflowText(false) && current !== workflowText(true) && visualConfigured && !/playwright install/.test(current)) {
      console.log('ℹ️  .github/workflows/guardrails.yml was modified by you and has no `npx playwright install --with-deps chromium` step; add it before `npm run guardrails -- --all` (the visual gate needs a browser).');
    } else {
      console.log('⏭️  Skipped existing .github/workflows/guardrails.yml (pass --force to overwrite)');
    }
  } else if (!fs.existsSync(wfPath) && existingGuards.nonGithubCi.length > 0 && existing.length === 0) {
    console.log(`ℹ️  ${existingGuards.nonGithubCi.join(', ')} found: no GitHub workflow was generated. Add one step to your pipeline: npm ci && npm run guardrails -- --all`);
    summary.push(['CI workflow', `skipped (non-GitHub CI: ${existingGuards.nonGithubCi[0]})`]);
  } else if (!fs.existsSync(wfPath) && existing.some((f) => /guardrails/.test(fs.readFileSync(path.join(wfDir, f), 'utf8')))) {
    console.log('⏭️  A workflow already runs guardrails: not creating .github/workflows/guardrails.yml');
  } else {
    writeIfMissingOrForce('.github/workflows/guardrails.yml', workflowText(visualConfigured), force);
  }
  if (cli.hooks) {
    writeIfMissingOrForce('.githooks/pre-push', `#!/bin/sh
# Fast-tier guardrails (no build/tests/network). Enable once per clone: git config core.hooksPath .githooks
exec npm run guardrails
`, force);
    try { fs.chmodSync(path.join(targetDir, '.githooks/pre-push'), 0o755); } catch {}
    console.log('ℹ️  Enable the hook with: git config core.hooksPath .githooks (nothing is set globally)');
  }
}

// ---------- 6. Install hint ----------
function typescriptCompatible() {
  const installed = readJson(path.join(targetDir, 'node_modules/typescript/package.json'))?.version;
  const spec = allDeclared.typescript ?? (isMonorepo ? workspaces.map((w) => ({ ...(w.pkg.dependencies ?? {}), ...(w.pkg.devDependencies ?? {}) }).typescript).find(Boolean) : undefined);
  const major = (v) => Number(String(v ?? '').match(/(\d+)\./)?.[1] ?? NaN);
  const m = installed ? major(installed) : major(spec);
  return m === 5 || m === 6;
}
const depcruiseInstalled =
  'dependency-cruiser' in allDeclared || (isMonorepo && wsDeclared('dependency-cruiser')) || fs.existsSync(path.join(targetDir, 'node_modules/dependency-cruiser'));
const toInstall = [...(depcruiseInstalled ? [] : ['dependency-cruiser']), ...(typescriptCompatible() ? [] : ['typescript@~5.9'])];
console.log(
  toInstall.length > 0
    ? `\nNext: npm install -D ${toInstall.join(' ')}   (supported TypeScript: 5.x-6.x; add @playwright/test if you enable visualSpecPath)`
    : '\nDependencies are in place (supported TypeScript: 5.x-6.x; add @playwright/test if you enable visualSpecPath).'
);
for (const n of notes) console.log(`ℹ️  ${n}`);
if (existingGuards.husky) console.log('ℹ️  .husky is left untouched. To run the fast tier on push add this line to .husky/pre-push: npm run guardrails');
if (existingGuards.verifyScript && !/guardrails/.test(manifest.scripts.verify ?? '')) console.log('ℹ️  Your "verify" script is untouched; append `&& npm run guardrails` to include the new checks.');
if (hasExistingGuards || cli.adopt) {
  for (const f of added) summary.unshift([f, 'installed']);
  if (layersFile) summary.push(['layers', `read from ${layersFile} (no copy)`]);
  if (skipImportRules.length > 0) summary.push([`check:imports rules ${skipImportRules.join('/')}`, `skipped (overlaps ${overlapFiles[0]})`]);
  console.log('\nInstalled / skipped:');
  for (const [k, v] of summary) console.log(`  ${k.padEnd(34)} ${v}`);
}
if (isMonorepo) {
  console.log(`ℹ️  Monorepo mode: ${workspaces.length} workspace(s). Run \`npm run guardrails\`; for a base ref use \`npm run guardrails -- --base origin/main\` (the \`--\` is required).`);
}

console.log(`\n🎯 Guardrails bootstrapped (${preset} preset${isMonorepo ? ', monorepo' : ''}) in ${targetDir}`);
