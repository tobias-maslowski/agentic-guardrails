import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, guardrailsConfig as cfg, isMonorepo, projects, readJson, toPosix } from './context.ts';
import { interactiveFiles } from './interactive.ts';
import { DEFAULT_TEST_GLOBS, DEFAULT_THRESHOLDS, defaultOptionalGates, defaultRequiredGates } from './defaults.ts';
import { DEFAULT_IGNORED_DIRS, walk } from './source-utils.ts';

export const NOOP_SCRIPT = /^\s*(true|:|exit\s+0|echo\b.*|node\s+-e\s+['"]?\s*['"]?|npm\s+run\s+true)\s*$/;
const RUNNER = /\b(node\s+(--\S+\s+)*--test|vitest|jest|playwright|mocha|ava|tap|uvu|bun\s+test|deno\s+test)\b/;
const hasTestFile = (dir: string): boolean => {
  const stack = [dir];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (e.isDirectory()) { if (!DEFAULT_IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(d, e.name)); }
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) return true;
    }
  }
  return false;
};
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));


/**
 * Lists every config choice that disables or narrows a check. The runner prints them and fails unless
 * `allowWeakenedConfig: true` is set together with a non-empty `weakenedConfigReason`.
 * Strict bootstrap defaults produce an empty list.
 */
export function weakenedChecks(): string[] {
  const out: string[] = [];
  const dirs = projects.map((p) => p.abs);
  const hasAny = (rel: string[]): boolean => dirs.some((d) => rel.some((r) => fs.existsSync(path.join(d, r))));

  if (!isMonorepo && (!Array.isArray(cfg.scopedModules) || cfg.scopedModules.length === 0)) {
    out.push('scopedModules is empty: no folder is required to carry a scoped AGENTS.md / Exported Modules registry.');
  }
  if (!isMonorepo && cfg.globalLayoutAstroPath == null && hasAny(['src/pages/index.astro'])) {
    out.push('globalLayoutAstroPath is null: leaked component selectors in the global layout are not checked.');
  }
  const interactive = interactiveFiles();
  if (cfg.visualSpecPath == null && interactive.length > 0) {
    out.push(`visualSpecPath is null: ${interactive.length} interactive file(s) have no Playwright spec (selector sync skipped).`);
  }
  if (cfg.requireTests === false) out.push('requireTests is false: a repo without any test script passes.');
  if (cfg.requireInteractiveSpecs === false && interactive.length > 0) {
    out.push('requireInteractiveSpecs is false: interactive behaviour without a spec is only an advisory.');
  }
  if (isMonorepo && Array.isArray(cfg.externalRules) && cfg.externalRules.length === 0) {
    out.push('externalRules is empty: no workspace is forbidden from importing node:*, cloudflare:*, astro:* or CMS SDKs.');
  }
  const deps = cfg.dependencies ?? {};
  if (deps.failOnOutdated === false) out.push('dependencies.failOnOutdated is false: outdated dependencies do not fail.');
  if (deps.failOnVulnerabilitySeverity === 'none') out.push("dependencies.failOnVulnerabilitySeverity is 'none': vulnerabilities do not fail.");
  const ack = Array.isArray(deps.acknowledgedAdvisories) ? deps.acknowledgedAdvisories : [];
  if (ack.length > 0) out.push(`dependencies.acknowledgedAdvisories has ${ack.length} entr${ack.length === 1 ? 'y' : 'ies'}: ${ack.map((a: any) => a?.package).join(', ')}.`);
  if (cfg.visualSpecPath != null && (!Array.isArray(cfg.uiTriggerPatterns) || cfg.uiTriggerPatterns.length === 0)) {
    out.push('uiTriggerPatterns is empty: only interactive files trigger the visual gate.');
  }
  if (cfg.requireAdr === false) out.push('requireAdr is false: no decision record is required.');
  if (cfg.storyblok && cfg.storyblok.requireStoryblokEditable === false) out.push('storyblok.requireStoryblokEditable is false: wrappers need not call storyblokEditable.');
  if (cfg.ratchetChangedFilesOnly === true || cfg.ratchet === true) out.push('ratchet is on: complexity advisories are only reported for changed files.');
  if (Array.isArray(cfg.layers) && cfg.layers.length === 1 && projects.length > 1) out.push('layers has a single layer: no layering direction is enforced between workspaces.');
  if (cfg.visualSpecPath != null && Array.isArray(cfg.uiTriggerPatterns) && cfg.uiTriggerPatterns.length > 0 && interactive.length > 0) {
    const unmatched = interactive.filter((f) => !cfg.uiTriggerPatterns.some((re: RegExp) => re.test(f.file)));
    if (unmatched.length > 0) out.push(`uiTriggerPatterns match none of ${unmatched.length} interactive file(s), e.g. ${unmatched[0].file}: they do not trigger the visual gate.`);
  }
  // adopt mode documents why the rules are skipped (existing tests enforce them); without a reason it is plain weakening
  if (Array.isArray(cfg.skipImportRules) && cfg.skipImportRules.length > 0 && !(typeof cfg.skipImportRulesReason === 'string' && cfg.skipImportRulesReason.trim())) {
    out.push(`skipImportRules (${cfg.skipImportRules.join(', ')}) skips check:imports rules without a skipImportRulesReason.`);
  }
  out.push(...externalRuleDeviations());
  out.push(...configDeviations());
  out.push(...testScriptProblems());
  out.push(...gateScriptProblems());
  return out;
}

const PURE_NAME = /^(domain|core|shared-types|types|utils)$/;
const globRe = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const BASE_FORBID = ['node:*', 'cloudflare:*', 'astro:*'];

/** externalRules narrowed below the bootstrap defaults: a pure package (domain|core|...) must stay covered by node:*, cloudflare:*, astro:*. */
function externalRuleDeviations(): string[] {
  if (!isMonorepo || !Array.isArray(cfg.externalRules) || cfg.externalRules.length === 0) return [];
  const out: string[] = [];
  const rules: Array<{ workspaces: string[]; forbid?: string[]; allowOnly?: string[] }> = cfg.externalRules;
  for (const p of projects) {
    const name = p.dir.split('/').pop() ?? '';
    if (!PURE_NAME.test(name) && !PURE_NAME.test(String(p.pkg?.name ?? '').split('/').pop() ?? '')) continue;
    const covering = rules.filter((r) => (r.workspaces ?? []).some((w) => w === p.dir || w === p.pkg?.name || globRe(w).test(p.dir)));
    const forbidden = new Set(covering.flatMap((r) => r.forbid ?? []));
    const hasAllowOnly = covering.some((r) => Array.isArray(r.allowOnly));
    const missing = BASE_FORBID.filter((f) => !forbidden.has(f) && !forbidden.has('*'));
    if (!hasAllowOnly && missing.length > 0) out.push(`externalRules narrowed: ${p.dir} is not forbidden from importing ${missing.join(', ')} (bootstrap default for pure packages).`);
  }
  return out;
}

const SHIPPED: Record<string, string> = {
  'check:arch': 'check-arch.ts',
  'check:drift': 'check-doc-drift.ts',
  'check:complexity': 'check-complexity.ts',
  'check:deps': 'check-deps.ts',
  'check:imports': 'check-imports.ts',
  'check:ssr': 'check-ssr.ts',
  'check:caching': 'check-caching.ts',
  'check:gate': 'check-gate.ts',
  guardrails: 'run-guardrails.ts',
};

const hasAstroFiles = (): boolean => projects.some((p) => walk(path.join(p.abs, 'src'), { accept: (n: string) => n.endsWith('.astro') }).length > 0);

/** Wrangler configs of the repo (root and workspaces) that declare `assets`. */
export function wranglerWithAssets(): string[] {
  const out: string[] = [];
  for (const d of new Set([ROOT, ...projects.map((p) => p.abs)])) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names.filter((x) => /^wrangler.*\.(json|jsonc|toml)$/.test(x))) {
      try { if (/["']?assets["']?\s*[:=\[{]/.test(fs.readFileSync(path.join(d, n), 'utf8'))) out.push(toPosix(path.relative(ROOT, path.join(d, n)))); } catch { /* ignore */ }
    }
  }
  return out;
}

/** Which check scripts must exist because their trigger exists. `check:gate` is exempt from "missing": the runner runs the shipped script directly. */
export function requiredScripts(): string[] {
  const out: string[] = [];
  if (isMonorepo) out.push('check:imports');
  if (hasAstroFiles()) out.push('check:ssr', 'check:caching');
  else if (projects.some((p) => fs.existsSync(path.join(p.abs, 'src/pages')) || fs.existsSync(path.join(p.abs, 'src/middleware.ts')))) out.push('check:caching');
  return out;
}

/** Gate scripts that were deleted, turned into no-ops or no longer point at the shipped script. */
function gateScriptProblems(): string[] {
  const out: string[] = [];
  const root = readJson(path.join(ROOT, 'package.json')) ?? {};
  const scripts: Record<string, string> = root.scripts ?? {};
  for (const [name, file] of Object.entries(SHIPPED)) {
    const cmd = scripts[name];
    if (typeof cmd !== 'string') continue;
    if (NOOP_SCRIPT.test(cmd)) out.push(`package.json: "${name}" script is a no-op (\`${cmd}\`).`);
    else if (!cmd.includes(file)) out.push(`package.json: "${name}" no longer runs the shipped ${file} (\`${cmd}\`).`);
  }
  for (const name of ['build', 'check:types', 'typecheck']) {
    const cmd = scripts[name];
    if (typeof cmd === 'string' && NOOP_SCRIPT.test(cmd)) out.push(`package.json: "${name}" script is a no-op (\`${cmd}\`).`);
  }
  if (isMonorepo) {
    for (const p of projects) {
      for (const name of ['build', 'check:types', 'typecheck']) {
        const cmd = p.pkg?.scripts?.[name];
        if (typeof cmd === 'string' && NOOP_SCRIPT.test(cmd)) out.push(`${p.dir}/package.json: "${name}" script is a no-op (\`${cmd}\`).`);
      }
    }
  }
  const reqGates: string[] = Array.isArray(cfg.requiredGates) ? cfg.requiredGates : defaultRequiredGates(isMonorepo);
  for (const name of new Set([...requiredScripts(), ...reqGates.filter((g) => SHIPPED[g] && g !== 'check:gate' && g !== 'check:deps' && g !== 'check:imports' && g !== 'check:ssr' && g !== 'check:caching')])) {
    const installed = fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), SHIPPED[name] ?? ''));
    if (installed && typeof scripts[name] !== 'string') out.push(`package.json: "${name}" script is missing although its trigger exists (required gate or trigger present); re-run the bootstrapper.`);
  }
  return out;
}

/** Deviations of the effective config from `defaults.ts`, listed by key. */
function configDeviations(): string[] {
  const out: string[] = [];
  if (Array.isArray(cfg.requiredGates)) {
    const missing = defaultRequiredGates(isMonorepo).filter((g) => !cfg.requiredGates.includes(g));
    if (missing.length) out.push(`requiredGates is narrowed below the defaults: missing ${missing.join(', ')}.`);
  }
  if (Array.isArray(cfg.optionalGates)) {
    const missing = defaultOptionalGates(isMonorepo).filter((g) => !cfg.optionalGates.includes(g) && !(Array.isArray(cfg.requiredGates) && cfg.requiredGates.includes(g)));
    if (missing.length) out.push(`optionalGates is narrowed below the defaults: missing ${missing.join(', ')}.`);
  }
  const srcDirs = new Set(['src', ...projects.map((p) => p.dir.split('/').pop() ?? '').filter(Boolean)]);
  for (const d of Array.isArray(cfg.importScanIgnoreDirs) ? cfg.importScanIgnoreDirs : []) {
    const base = String(d).replace(/^\.?\//, '').replace(/\/$/, '');
    if (base === 'src' || base.endsWith('/src') || srcDirs.has(base) || projects.some((p) => p.dir && (p.dir === base || p.dir.endsWith(`/${base}`)))) {
      out.push(`importScanIgnoreDirs contains "${d}": source code is excluded from check:imports.`);
    }
  }
  for (const a of Array.isArray(cfg.docClaimsAllow) ? cfg.docClaimsAllow : []) {
    const v = String(a).trim();
    if (v === '' || /^[*/.]+$/.test(v) || v === '**/*' || v === '*/**') out.push(`docClaimsAllow contains the catch-all "${a}": every doc path claim is accepted.`);
  }
  const t = cfg.thresholds ?? {};
  for (const [k, def] of Object.entries(DEFAULT_THRESHOLDS)) {
    if (typeof t[k] === 'number' && t[k] > def) out.push(`thresholds.${k} is ${t[k]} (default ${def}): raised above the default.`);
  }
  if (Array.isArray(cfg.testGlobs) && !sameSet(cfg.testGlobs, DEFAULT_TEST_GLOBS)) {
    for (const g of cfg.testGlobs) {
      const v = String(g);
      const broad = /^(\*\*\/)?\*+(\/\*+)*$/.test(v) || /(^|\/)src(\/|$)/.test(v) || /^\*\*\/(\*\*|\*\.(ts|js|astro|tsx|mjs))$/.test(v) || /^\*\*\/\*\.\{?[a-z,]+\}?$/.test(v);
      if (broad && !DEFAULT_TEST_GLOBS.includes(v)) out.push(`testGlobs contains "${g}": it matches source files broadly, exempting them from import rules.`);
    }
  }
  return out;
}

/** A `test` script must really run something: a known runner, or at least one test file next to it. */
function testScriptProblems(): string[] {
  const out: string[] = [];
  for (const p of [{ dir: '', abs: ROOT, pkg: readJson(path.join(ROOT, 'package.json')) ?? {} }, ...(isMonorepo ? projects : [])]) {
    const cmd = p.pkg?.scripts?.test;
    if (typeof cmd !== 'string') continue;
    const where = p.dir ? `${p.dir}/package.json` : 'package.json';
    if (NOOP_SCRIPT.test(cmd)) out.push(`${where}: "test" script is a no-op (\`${cmd}\`).`);
    else if (!RUNNER.test(cmd) && !/\bnpm\s+(run|test)\b|\bnpx\b|\bpnpm\b|\byarn\b/.test(cmd) && !hasTestFile(p.abs)) {
      out.push(`${where}: "test" script (\`${cmd}\`) has no known test runner and no *.test/*.spec file exists.`);
    }
  }
  return out;
}

export function weakenedVerdict(): { lines: string[]; fail: boolean } {
  const lines = weakenedChecks();
  if (lines.length === 0) return { lines, fail: false };
  const reason = typeof cfg.weakenedConfigReason === 'string' ? cfg.weakenedConfigReason.trim() : '';
  const allowed = cfg.allowWeakenedConfig === true && reason.length > 0;
  console.log('\n⚠️  Disabled or weakened checks:');
  for (const l of lines) console.log(`   • ${l}`);
  if (allowed) console.log(`   Accepted: allowWeakenedConfig is true. Reason: ${reason}`);
  else {
    console.error('   Fix the config, or accept it explicitly with `allowWeakenedConfig: true` and a `weakenedConfigReason: "<why>"` in guardrails.config.ts.');
  }
  return { lines, fail: !allowed };
}
