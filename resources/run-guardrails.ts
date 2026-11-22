import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, guardrailsConfig, isMonorepo, projects, readJson, toPosix } from './context.ts';
import { getChangedFiles } from './git-changes.ts';
import { interactiveFiles } from './interactive.ts';
import { DEFAULT_IGNORED_DIRS, walk } from './source-utils.ts';
import { defaultOptionalGates, defaultRequiredGates } from './defaults.ts';
import { requiredScripts, weakenedVerdict, wranglerWithAssets } from './weakened.ts';

/**
 * Diff-Aware Guardrail Runner (scripts/run-guardrails.ts, or scripts/guardrails/ in monorepo mode)
 *
 * Runs EVERY selected gate (no fail-fast) and reports all failures at the end; exits 1 if any gate failed.
 *
 * Tiers
 *  - Fast tier, always: check:imports, check:ssr, check:caching, check:drift, check:arch, check:complexity (and any other
 *    gate you list in `requiredGates`), plus check:deps in offline mode (banned / unpinned packages, no network).
 *  - Slow tier, only with `--all` or in CI (`CI=true`): build, check:types / typecheck, test, check:visual (Playwright)
 *    and the network part of check:deps (`--audit`: CVE audit + outdated). Git unavailable counts as `--all` (fail closed).
 *    Skipped slow gates are listed on one line.
 *
 * Scope (diff-aware where it is safe)
 *  - check:imports, check:ssr and check:caching scan the changed files plus their transitive importers.
 *    check:arch, check:drift, check:complexity (which has its own `--base` aware reporting) and check:deps stay full:
 *    their verdict depends on the whole tree (layer rules, doc claims, duplicates, manifests).
 *  - A full scan runs with `--all`, in CI, on a clean tree without `--base`, and when a package.json, lockfile, tsconfig,
 *    guardrails config, astro.config or an installed guardrail script changed, or a source file was deleted/renamed.
 *
 * Output: one line per check with elapsed ms; details only for failures (at most 20 findings per check; `--verbose` shows
 * everything, including advisories). A `.guardrails-cache/` skips fast gates whose inputs (file sizes + mtimes of the whole
 * tree, which includes the config) are unchanged since their last pass; `--all`, CI and `--no-cache` bypass it.
 *
 * Config: `requiredGates`, `optionalGates`, `requireTests`, `fastTierBudgetMs` (default 10000, warning only).
 *
 * Usage: npm run guardrails -- [--all] [--base <ref>] [--verbose] [--no-cache]   (the `--` hands the flags to the script)
 */

const USAGE =
  'Usage: npm run guardrails -- [--all] [--base <ref>] [--verbose] [--no-cache]\n' +
  '  --all          also run the slow tier (build, types, tests, visual, network audit) and scan everything\n' +
  '  --base <ref>   also treat files changed in <ref>...HEAD as changed (CI)\n' +
  '  --verbose      print full output of every check, including advisories\n' +
  '  --no-cache     ignore .guardrails-cache/';

function usageError(msg: string): never {
  console.error(`❌ ${msg}\n${USAGE}`);
  process.exit(1);
}

function parseCli(argv: string[]): { all: boolean; base?: string; verbose: boolean; noCache: boolean } {
  let all = false;
  let verbose = false;
  let noCache = false;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--no-cache') noCache = true;
    else if (a === '--base') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) usageError('--base requires a value.');
      base = v;
    } else if (a.startsWith('--base=')) {
      base = a.slice('--base='.length);
      if (!base) usageError('--base requires a value.');
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else usageError(a.startsWith('-') ? `Unknown flag "${a}".` : `Unexpected argument "${a}".`);
  }
  return { all, base, verbose, noCache };
}

const cli = parseCli(process.argv.slice(2));
const isCI = !!process.env.CI && !/^(0|false)$/i.test(process.env.CI);
const startedAt = Date.now();

// Workspace and root manifests/lockfiles at any depth.
const DEP_FILE_PATTERNS = [/(^|\/)package\.json$/, /(^|\/)(package-lock|npm-shrinkwrap)\.json$/];
// A change to one of these can alter the verdict for every file: scan everything.
const FULL_SCAN_PATTERNS = [
  ...DEP_FILE_PATTERNS,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)guardrails\.config\.[cm]?[jt]s$/,
  /(^|\/)astro\.config\.[cm]?[jt]s$/,
  /(^|\/)\.?dependency-cruiser\.cjs$/,
  /(^|\/)scripts\/(guardrails\/)?(check-[\w-]+|run-guardrails|context|scope|ts-api|ts-support|source-utils|doc-claims|resolve-import|request-reads|cache-headers|interactive|weakened|workspace-globs|git-changes|layers-file|defaults)\.ts$/,
  /(^|\/)module-layers\.json$/,
];
// Stateful (/g, /y) patterns would alternate between match and miss across calls.
const matchesAny = (patterns: RegExp[], file: string) =>
  patterns.some((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, '')).test(file));

const rootPkg = readJson(path.join(ROOT, 'package.json')) ?? {};
const rootScripts: Record<string, unknown> =
  rootPkg.scripts && typeof rootPkg.scripts === 'object' && !Array.isArray(rootPkg.scripts) ? rootPkg.scripts : {};
const hasRootScript = (name: string): boolean => typeof rootScripts[name] === 'string';
const workspacesWithScript = (name: string): string[] =>
  isMonorepo ? projects.filter((p) => typeof p.pkg.scripts?.[name] === 'string').map((p) => p.dir) : [];

function hasAstro(dir: string): boolean {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.') && hasAstro(path.join(dir, e.name))) return true;
      } else if (e.name.endsWith('.astro')) return true;
    }
  } catch {
    // unreadable
  }
  return false;
}

// ---------- changed files and scope ----------

const CACHE_DIR = path.join(ROOT, '.guardrails-cache');
let forceAll = cli.all;
const changedRaw = getChangedFiles({ cwd: ROOT, base: cli.base });
if (changedRaw === null && !forceAll) {
  // Unknown is not "nothing changed": fail closed by running every gate.
  console.warn('⚠️  Git status unavailable (not a git work tree?). Running all gates as if --all was passed.');
  forceAll = true;
}
const changed = (changedRaw ?? []).filter((f) => !f.startsWith('.guardrails-cache/'));
const baseArgs = cli.base ? ['--base', cli.base] : [];
const slowEnabled = forceAll || isCI;

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|astro)$/;
let fullReason: string | null = null;
if (forceAll) fullReason = 'full scan (--all or git unavailable)';
else if (isCI) fullReason = 'full scan (CI)';
else if (changed.length === 0 && !cli.base) fullReason = 'full scan (clean tree, nothing to diff against)';
else {
  const trigger = changed.find((f) => matchesAny(FULL_SCAN_PATTERNS, f));
  const removed = changed.find((f) => SOURCE_RE.test(f) && !fs.existsSync(path.join(ROOT, f)));
  if (trigger) fullReason = `full scan (${trigger} changed)`;
  else if (removed) fullReason = `full scan (${removed} was deleted or renamed)`;
}

const IMPORT_SPEC_RES = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Changed files plus every source file that transitively imports one of them; null when the scope cannot be computed. */
async function computeScope(): Promise<Set<string> | null> {
  let resolveImport: (from: string, spec: string) => string | null;
  try {
    ({ resolveImport } = await import('./resolve-import.ts'));
  } catch {
    return null;
  }
  const scope = new Set<string>();
  const queue: string[] = [];
  for (const f of changed) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      scope.add(abs);
      queue.push(abs);
    }
  }
  const importers = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const abs of walk(project.abs, { accept: (n) => SOURCE_RE.test(n) && !n.endsWith('.d.ts') })) {
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      for (const re of IMPORT_SPEC_RES) {
        for (const m of text.matchAll(re)) {
          let target: string | null = null;
          try {
            target = resolveImport(abs, m[1].replace(/[?#].*$/, ''));
          } catch {
            target = null;
          }
          if (target) (importers.get(target) ?? importers.set(target, new Set()).get(target)!).add(abs);
        }
      }
    }
  }
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const importer of importers.get(cur) ?? []) {
      if (!scope.has(importer)) {
        scope.add(importer);
        queue.push(importer);
      }
    }
  }
  return scope;
}

let scopeFile: string | undefined;
let scopeSummary = fullReason ?? '';
if (!fullReason) {
  const scope = await computeScope();
  if (scope === null) scopeSummary = 'full scan (import graph unavailable)';
  else {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    scopeFile = path.join(CACHE_DIR, 'scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify([...scope]));
    scopeSummary = `diff scope: ${changed.length} changed file(s), ${scope.size} with importers`;
  }
}

// ---------- gate execution ----------

const SLOW_GATES = new Set(['build', 'check:types', 'typecheck', 'test', 'check:visual']);
const MAX_FINDINGS = 20;
const failures: string[] = [];
let gatesRun = 0;
let hiddenAdvisories = 0;
let fastMs = 0;
const skippedSlow: string[] = [];

function treeHash(): string {
  const h = crypto.createHash('sha1');
  const skip = new Set([...DEFAULT_IGNORED_DIRS, '.guardrails-cache']);
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && (e.name === '.github' || !e.name.startsWith('.'))) visit(abs);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          h.update(`${toPosix(path.relative(ROOT, abs))}:${st.size}:${Math.round(st.mtimeMs)}\n`);
        } catch {
          // vanished while walking
        }
      }
    }
  };
  visit(ROOT);
  return h.digest('hex');
}
let treeKey: string | undefined;
const cacheKey = (gate: string): string => {
  treeKey ??= treeHash();
  return crypto.createHash('sha1').update(`${gate}\0${treeKey}\0${scopeSummary}\0${cli.base ?? ''}`).digest('hex');
};
const cacheFile = (gate: string): string => path.join(CACHE_DIR, `${gate.replace(/[^\w-]/g, '_')}.json`);
const cacheEnabled = !slowEnabled && !cli.noCache;

/** Failure output with findings beyond MAX_FINDINGS hidden (a finding is a `  • ` bullet plus its indented lines). */
function capFindings(output: string): string {
  const out: string[] = [];
  let count = 0;
  let hidden = 0;
  let inHidden = false;
  for (const line of output.split('\n')) {
    if (/^\s{2}• /.test(line)) {
      count++;
      inHidden = count > MAX_FINDINGS;
      if (inHidden) hidden++;
    } else if (inHidden && /^\s{4,}\S/.test(line)) continue;
    else inHidden = false;
    if (!inHidden) out.push(line);
  }
  if (hidden > 0) out.push(`  +${hidden} more finding(s) (use --verbose)`);
  return out.join('\n');
}

const MAX_OUTPUT_LINES = 40;
let reportWritten: string | null = null;
/** `--all` keeps the complete output of every failing check in `.guardrails-cache/report.txt`. */
function reportFile(label: string, output: string): string {
  const file = path.join(CACHE_DIR, 'report.txt');
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (reportWritten === null) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `===== ${label} =====\n${output.trimEnd()}\n\n`);
    reportWritten = file;
  } catch {
    // report is best effort
  }
  return path.relative(ROOT, file);
}

function countAdvisories(output: string): number {
  let n = 0;
  for (const line of output.split('\n')) {
    const m = line.match(/Advisories\] \((\d+) finding/);
    if (m) n += Number(m[1]);
    else if (/^\s*ℹ️/.test(line) || /^\s*⚠️\s+ADVISORY/.test(line)) n++;
  }
  return n;
}

function summaryOf(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => /^(✅|⏭️)/.test(l));
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^(✅|⏭️)\s*/, '').slice(0, 140);
}

const BANNER = /(npx playwright install|Looks like Playwright|browserType\.launch: Executable|[╔╗╚╝║═]|^\s*$)/;

/** Playwright output: tests must actually have run. Returns the summary and an error when 0 passed / none found. */
function playwrightVerdict(output: string): { summary: string; problem: string | null } {
  const n = (re: RegExp): number => Number(output.match(re)?.[1] ?? 0);
  const passed = n(/(\d+)\s+passed/);
  const skipped = n(/(\d+)\s+skipped/);
  const summary = `${passed} passed, ${skipped} skipped`;
  if (/no tests found/i.test(output)) return { summary, problem: 'Playwright found no tests (check testDir/testMatch and the spec path).' };
  if (passed === 0) return { summary, problem: skipped > 0 ? `Playwright ran 0 tests: all ${skipped} skipped.` : 'Playwright reported no passing tests (0 ran, or its summary could not be read).' };
  return { summary, problem: null };
}

interface Job {
  label: string;
  gate: string;
  cmd: string;
  args: string[];
  tier: 'fast' | 'slow';
  verify: boolean;
  cwd: string;
  key: string | null;
}
interface JobResult {
  status: number | null;
  output: string;
  error?: Error;
  ms: number;
}
const queue: Job[] = [];

/** Queues a gate; `flushJobs()` runs the queued fast-tier gates concurrently and the slow ones one after another. */
function run(label: string, gate: string, cmd: string, args: string[], tier: 'fast' | 'slow', verify = false, cwd: string = ROOT): void {
  gatesRun++;
  queue.push({ label, gate, cmd, args, tier, verify, cwd, key: cacheEnabled && tier === 'fast' ? cacheKey(gate) : null });
}

const jobEnv = (job: Job) => ({ ...process.env, ...(scopeFile && job.tier === 'fast' ? { GUARDRAILS_SCOPE_FILE: scopeFile } : {}) });

function execAsync(job: Job): Promise<JobResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks: string[] = [];
    const child = spawn(job.cmd, job.args, { cwd: job.cwd, env: jobEnv(job), shell: process.platform === 'win32' });
    child.stdout?.setEncoding('utf8').on('data', (d) => chunks.push(d));
    child.stderr?.setEncoding('utf8').on('data', (d) => chunks.push(d));
    child.on('error', (error) => resolve({ status: null, output: chunks.join(''), error, ms: Date.now() - t0 }));
    child.on('close', (status) => resolve({ status, output: chunks.join(''), ms: Date.now() - t0 }));
  });
}

function execSync(job: Job): JobResult {
  const t0 = Date.now();
  const r = spawnSync(job.cmd, job.args, { cwd: job.cwd, encoding: 'utf8', env: jobEnv(job), maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error, ms: Date.now() - t0 };
}

function cachedHit(job: Job): boolean {
  if (!job.key) return false;
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile(job.gate), 'utf8'));
    if (hit.key === job.key) {
      hiddenAdvisories += Number(hit.advisories) || 0;
      console.log(`⏩ ${job.label}  cached (inputs unchanged since its last pass)`);
      return true;
    }
  } catch {
    // no usable cache entry
  }
  return false;
}

function report(job: Job, res: JobResult): void {
  const { label, gate, verify, key } = job;
  const { output, ms } = res;
  const verdict = verify && !res.error && res.status === 0 ? playwrightVerdict(output) : null;
  const ok = !res.error && res.status === 0 && !verdict?.problem;
  const advisories = countAdvisories(output);
  if (ok) {
    hiddenAdvisories += advisories;
    const summary = verdict ? verdict.summary : summaryOf(output);
    console.log(`✅ ${label}  ${ms}ms${summary ? `  ${summary}` : ''}`);
    if (cli.verbose) console.log(output.trimEnd().split('\n').map((l) => `   ${l}`).join('\n'));
    if (key) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile(gate), JSON.stringify({ key, advisories }));
      } catch {
        // cache is best effort
      }
    }
    return;
  }
  console.error(`❌ ${label}  ${ms}ms`);
  if (res.error) console.error(`   ${res.error.message}`);
  if (verdict?.problem) console.error(`   ${verdict.problem} (${verdict.summary})`);
  let text = output.trimEnd();
  if (verify && !cli.verbose) {
    const lines = text.split('\n').filter((l) => !BANNER.test(l));
    text = lines.length > 25 ? `${lines.slice(0, 25).join('\n')}\n  +${lines.length - 25} more line(s) (use --verbose)` : lines.join('\n');
  }
  let shown = cli.verbose ? output.trimEnd() : verify ? text : capFindings(text);
  if (!cli.verbose) {
    const lines = shown.split('\n');
    if (lines.length > MAX_OUTPUT_LINES) shown = `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n  +${lines.length - MAX_OUTPUT_LINES} more line(s) (use --verbose${forceAll ? `, or see ${reportFile(label, output)}` : ''})`;
  }
  if (forceAll && !cli.verbose && output.trim()) reportFile(label, output);
  if (shown) console.error(shown.split('\n').map((l) => `   ${l}`).join('\n'));
  console.error(`\n❌ Guardrail failed: ${label}`);
  failures.push(label);
}

const FAST_CONCURRENCY = 4;
async function flushJobs(): Promise<void> {
  const jobs = queue.splice(0);
  const fast = jobs.filter((j) => j.tier === 'fast');
  const results = new Map<Job, JobResult>();
  const pending = fast.filter((j) => !cachedHit(j));
  const t0 = Date.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(FAST_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length) {
        const job = pending[next++];
        results.set(job, await execAsync(job));
      }
    })
  );
  if (pending.length > 0) fastMs += Date.now() - t0;
  for (const job of pending) report(job, results.get(job)!);
  for (const job of jobs.filter((j) => j.tier === 'slow')) report(job, execSync(job));
}

const tierOf = (gate: string): 'fast' | 'slow' => (SLOW_GATES.has(gate) ? 'slow' : 'fast');
const npmRun = (gate: string, extra: string[] = [], tier: 'fast' | 'slow' = tierOf(gate), verify = false): void =>
  run(`npm run ${gate}${extra.length ? ' ' + extra.join(' ') : ''}`, gate, 'npm', ['run', '--silent', gate, ...extra], tier, verify);

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_FILE: Record<string, string> = {
  'check:arch': 'check-arch.ts',
  'check:drift': 'check-doc-drift.ts',
  'check:complexity': 'check-complexity.ts',
  'check:deps': 'check-deps.ts',
  'check:imports': 'check-imports.ts',
  'check:ssr': 'check-ssr.ts',
  'check:caching': 'check-caching.ts',
  'check:gate': 'check-gate.ts',
};
const shippedPath = (gate: string): string | null => {
  const f = SHIPPED_FILE[gate] && path.join(here, SHIPPED_FILE[gate]);
  return f && fs.existsSync(f) ? f : null;
};
/** Gates whose trigger exists: they run even when the npm script is missing or no longer points at the shipped script. */
const triggered = (gate: string): boolean =>
  gate === 'check:gate' ? wranglerWithAssets().length > 0 : requiredScripts().includes(gate);

const depsScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-deps.ts');
const depFilesChanged = changed.some((file) => matchesAny(DEP_FILE_PATTERNS, file));

function missingScript(gate: string): void {
  console.error(`\n❌ Required gate "${gate}" has no npm script in package.json. Re-run the bootstrapper or add the script.`);
  failures.push(`npm run ${gate} (script missing)`);
}

let checkReused = false;
function runGate(gate: string, isRequired: boolean): void {
  if (gate === 'check:visual') return; // handled below
  if (gate === 'check:deps') {
    const audit = slowEnabled;
    if (!audit && changed.some((f) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(f))) console.log('ℹ️  package-lock.json changed: only the offline dependency checks ran; run `npm run guardrails -- --all` for the network audit.');
    if (!audit) skippedSlow.push(`check:deps network audit/outdated${depFilesChanged ? ' (dependency files changed: offline checks ran)' : ''}`);
    run(`check-deps${audit ? ' --audit' : ' (offline)'}`, 'check:deps', process.execPath, ['--experimental-strip-types', '--no-warnings', depsScript, ...(audit ? ['--audit'] : [])], audit ? 'slow' : 'fast');
    return;
  }
  const file = shippedPath(gate);
  const script = rootScripts[gate];
  if (file && (triggered(gate) || isRequired) && !(typeof script === 'string' && script.includes(SHIPPED_FILE[gate]))) {
    // missing or replaced script: run the shipped check itself (weakened.ts reports the script problem)
    console.log(`ℹ️  ${gate}: ${typeof script === 'string' ? 'npm script no longer runs the shipped check' : 'no npm script'}; ran ${path.relative(ROOT, file)} directly.`);
    run(`node ${path.relative(ROOT, file)}`, gate, process.execPath, ['--experimental-strip-types', '--no-warnings', file, ...(gate === 'check:complexity' ? baseArgs : [])], 'fast');
    return;
  }
  if ((gate === 'check:types' || gate === 'typecheck') && !hasRootScript('check:types') && !hasRootScript('typecheck') && hasRootScript('check') && !/guardrails/.test(String(rootScripts.check))) {
    if (checkReused) return;
    checkReused = true;
    if (!slowEnabled) skippedSlow.push('check (reused as the type gate)');
    else {
      console.log('ℹ️  check:types: reusing the existing root `check` script as the type gate.');
      npmRun('check', [], 'slow');
    }
    return;
  }
  const has = hasRootScript(gate);
  const inWorkspaces = !has && !isRequired && (workspacesWithScript(gate).length > 0 || (gate === 'test' && workspacesWithScript('test:unit').length > 0));
  if (tierOf(gate) === 'slow' && !slowEnabled) {
    if (has || inWorkspaces) skippedSlow.push(gate);
    else if (isRequired) missingScript(gate);
    return;
  }
  if (gate === 'test' && !has && !inWorkspaces && workspacesWithScript('test:unit').length > 0) {
    npmRun('test:unit', ['--workspaces', '--if-present']);
    return;
  }
  if (has) npmRun(gate, gate === 'check:complexity' && baseArgs.length ? ['--', ...baseArgs] : []);
  else if (inWorkspaces) npmRun(gate, ['--workspaces', '--if-present']);
  else if (isRequired) missingScript(gate);
}

const required: string[] = Array.isArray(guardrailsConfig.requiredGates) ? guardrailsConfig.requiredGates : defaultRequiredGates(isMonorepo);
const optional: string[] = Array.isArray(guardrailsConfig.optionalGates) ? guardrailsConfig.optionalGates : defaultOptionalGates(isMonorepo);

console.log(`ℹ️  guardrails: ${scopeSummary}; ${slowEnabled ? 'slow tier on' : 'fast tier only'}${isCI ? ' (CI)' : ''}`);

const seen = new Set<string>();
const ordered: Array<readonly [string, boolean]> = [...required.map((g) => [g, true] as const), ...optional.map((g) => [g, false] as const)];
// triggers win over a narrowed gate list (the narrowing itself is reported as weakened)
for (const g of ['check:gate']) if (!ordered.some(([x]) => x === g) && triggered(g)) ordered.push([g, false]);
// `typecheck` is an alias of `check:types`: run only one of them.
/** Directories (root-relative, '' = root) that have a playwright.config.*: discovered in the root and every workspace. */
function playwrightDirs(): string[] {
  const out: string[] = [];
  for (const p of [{ dir: '', abs: ROOT }, ...projects]) {
    if (['ts', 'js', 'mjs', 'cjs', 'mts'].some((x) => fs.existsSync(path.join(p.abs, `playwright.config.${x}`)))) out.push(p.dir);
  }
  return out;
}
const typeAliases = ['check:types', 'typecheck'];
let typesDone = false;
for (const [gate, isRequired] of ordered) {
  if (seen.has(gate)) continue;
  seen.add(gate);
  if (typeAliases.includes(gate)) {
    if (typesDone) continue;
    if (hasRootScript(gate) || workspacesWithScript(gate).length > 0) typesDone = true;
  }
  runGate(gate, isRequired);
}
await flushJobs();

if (isMonorepo && guardrailsConfig.requireTests !== false && !hasRootScript('test') && workspacesWithScript('test').length === 0 && !required.includes('test')) {
  console.error(
    '\n❌ No `test` script in the root package.json or any workspace; a monorepo without tests fails by default.\n' +
      '   Fix: add a `test` script (root or workspace), or opt out with `requireTests: false` in guardrails.config.ts.'
  );
  failures.push('tests (no test script anywhere)');
}

const weak = weakenedVerdict();
if (weak.fail) failures.push('weakened config (see "Disabled or weakened checks")');

const astroFiles = projects.filter((p) => fs.existsSync(path.join(p.abs, 'src')) && hasAstro(path.join(p.abs, 'src')));
const typeScripts = [...Object.values(rootScripts), ...projects.flatMap((p) => Object.values(p.pkg.scripts ?? {}))].filter((v): v is string => typeof v === 'string');
if (astroFiles.length > 0 && !typeScripts.some((v) => /astro\s+check/.test(v))) {
  const msg = `ℹ️  [Advisory] .astro files in ${astroFiles.map((p) => p.dir || '.').join(', ')} are never type-checked. Fix: npm i -D @astrojs/check, then add a \`check:types\` script running \`astro check\`.`;
  if (cli.verbose) console.log(`\n${msg}`);
  else hiddenAdvisories++;
}

if (guardrailsConfig.visualSpecPath) {
  const interactivePaths = new Set(interactiveFiles().map((f) => f.file));
  const touchedUiFiles = changed.filter((file) => matchesAny(guardrailsConfig.uiTriggerPatterns, file) || interactivePaths.has(file));
  const wanted = forceAll || touchedUiFiles.length > 0 || (isCI && !cli.base);
  if (wanted && slowEnabled) {
    const reason = forceAll ? '--all flag passed' : touchedUiFiles.length > 0 ? `UI changes detected (${touchedUiFiles.join(', ')})` : 'CI without --base';
    console.log(`🔍 Playwright Visual Guardrail [${reason}]`);
    if (hasRootScript('check:visual')) npmRun('check:visual', ['--', '--reporter=line'], 'slow', true);
    else {
      const dirs = playwrightDirs();
      if (dirs.length === 0) console.log('⏭️  check:visual: no root script and no playwright.config.* in any workspace; nothing to run.');
      for (const d of dirs) {
        console.log(`ℹ️  check:visual: no root script; running Playwright from ${d || '.'}.`);
        run(`playwright test (${d || '.'})`, 'check:visual', 'npx', ['--no-install', 'playwright', 'test', '--reporter=line'], 'slow', true, path.join(ROOT, d));
      }
    }
  } else if (wanted) {
    skippedSlow.push(`check:visual (UI files changed: ${touchedUiFiles.slice(0, 3).join(', ')}${touchedUiFiles.length > 3 ? ', …' : ''})`);
  } else {
    console.log('⚡ Playwright Visual Guardrail: skipped (no changed files match triggers); use --all or CI.');
  }
}

await flushJobs();

if (skippedSlow.length > 0) console.log(`⏭️  Skipped slow tier (local run; use --all or CI=true): ${skippedSlow.join(', ')}.`);
if (hiddenAdvisories > 0 && !cli.verbose) console.log(`ℹ️  ${hiddenAdvisories} advisory finding(s) not shown; use --verbose.`);

const totalMs = Date.now() - startedAt;
const budget = Number.isFinite(guardrailsConfig.fastTierBudgetMs) ? Number(guardrailsConfig.fastTierBudgetMs) : 10_000;
console.log(`⏱️  total ${totalMs}ms (fast tier checks ${fastMs}ms, budget ${budget}ms)`);
if (fastMs > budget) {
  console.warn(`⚠️  Fast tier took ${fastMs}ms, above fastTierBudgetMs (${budget}ms). Narrow the scope, or raise fastTierBudgetMs in guardrails.config.ts if this is expected.`);
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} guardrail failure(s) (${gatesRun} gate(s) run):`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ All guardrail gates passed (${gatesRun} gate(s) run).`);
