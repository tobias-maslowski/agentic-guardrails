import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { walk } from './source-utils.ts';
import { ROOT, guardrailsConfig, isMonorepo, projects } from './context.ts';
import { inScope, isDiffScoped } from './scope.ts';

/**
 * Architecture gate (scripts/check-arch.ts): runs dependency-cruiser (in-package layer rules from
 * `.dependency-cruiser.cjs`) in every project that has an `src` directory (`archDirs`, default ['src']) and
 * fails, instead of printing a green, when
 *  - dependency-cruiser is not installed,
 *  - it reports a missing transpiler / unresolvable parser (modules would be silently skipped),
 *  - it cruised 0 modules (the rules checked nothing),
 *  - or it reports rule violations.
 * Cross-workspace boundaries are covered by `check:imports` (monorepo mode). Type-only imports are ignored for
 * circularity (`tsPreCompilationDeps: false`). With a diff scope only workspaces that contain changed files are cruised
 * (a cycle or layer rule can only involve files of one workspace); --all / config changes cruise everything.
 * Workspaces run in parallel and the output is ONE summary line plus findings.
 */

const configFile = path.join(ROOT, '.dependency-cruiser.cjs');
const dirs: string[] = Array.isArray(guardrailsConfig.archDirs) && guardrailsConfig.archDirs.length > 0 ? guardrailsConfig.archDirs : ['src'];
const bin = [path.join(ROOT, 'node_modules/.bin/depcruise'), path.join(ROOT, 'node_modules/.bin/dependency-cruise')].find((p) => fs.existsSync(p));
const fail = (msg: string): never => {
  console.error(`\n❌ check:arch failed: ${msg}\n`);
  process.exit(1);
};

if (!fs.existsSync(configFile)) fail('.dependency-cruiser.cjs not found. Re-run the bootstrapper.');
if (!bin) fail('dependency-cruiser is not installed. Run: npm install -D dependency-cruiser');

const TRANSPILER = /transpiler|not (?:installed|available|found)|cannot find (?:module|package)|unsupported|isn't (?:installed|available)/i;
const CRUISABLE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const isDts = (f: string) => f.endsWith('.d.ts');

interface Outcome {
  label: string;
  cruised: number;
  layerRules: number;
  astroCount: number;
  skippedAstroOnly: boolean;
  skippedUnchanged: boolean;
  errors: string[];
}

function cruiseProject(project: (typeof projects)[number]): Promise<Outcome> {
  const present = dirs.filter((d) => fs.existsSync(path.join(project.abs, d)));
  const label = project.dir || '.';
  const out: Outcome = { label, cruised: 0, layerRules: 0, astroCount: 0, skippedAstroOnly: false, skippedUnchanged: false, errors: [] };
  if (present.length === 0) return Promise.resolve(out);
  const files = present.flatMap((d) => walk(path.join(project.abs, d), { accept: () => true }));
  out.astroCount = files.filter((f) => f.endsWith('.astro')).length;
  const cruisable = files.filter((f) => CRUISABLE.test(f) && !isDts(f)).length;
  if (cruisable === 0 && out.astroCount > 0) {
    out.skippedAstroOnly = true;
    return Promise.resolve(out);
  }
  if (isDiffScoped && !files.some((f) => inScope(f))) {
    out.skippedUnchanged = true;
    return Promise.resolve(out);
  }
  return new Promise((resolve) => {
    const child = spawn(bin!, [...present, '--config', configFile, '--output-type', 'json'], { cwd: project.abs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      out.errors.push(`${label}: dependency-cruiser could not run (${e.message}).`);
      resolve(out);
    });
    child.on('close', (code) => {
      const diagnostics = stderr.trim();
      if (diagnostics && TRANSPILER.test(diagnostics)) {
        out.errors.push(`${label}: dependency-cruiser reports a missing/unsupported transpiler:\n      ${diagnostics.split('\n').slice(0, 3).join('\n      ')}\n      fix: npm install -D typescript@~5.9 (and keep dependency-cruiser current)`);
        return resolve(out);
      }
      let summary: any;
      try {
        summary = JSON.parse(stdout).summary;
      } catch {
        out.errors.push(`${label}: dependency-cruiser produced no readable report (exit ${code}). ${diagnostics.split('\n')[0] ?? ''}`);
        return resolve(out);
      }
      out.cruised = Number(summary?.totalCruised ?? 0);
      const used: any[] = Array.isArray(summary?.ruleSetUsed) ? summary.ruleSetUsed : Array.isArray(summary?.ruleSetUsed?.forbidden) ? summary.ruleSetUsed.forbidden : [];
      out.layerRules = used.map((x) => x?.name).filter((x) => x && x !== 'no-circular-dependencies').length;
      if (out.cruised === 0) out.errors.push(`${label}: dependency-cruiser cruised 0 modules in ${present.join(', ')} although it has ${cruisable} cruisable file(s); the rules checked nothing.`);
      const violations: any[] = Array.isArray(summary?.violations) ? summary.violations : [];
      for (const v of violations.filter((x) => x.rule?.severity === 'error' || x.rule?.severity === undefined)) {
        const to = v.type === 'cycle' && Array.isArray(v.cycle) ? v.cycle.map((c: any) => c.name).join(' -> ') : v.to;
        out.errors.push(`${label}: [${v.rule?.name}] ${v.from} -> ${to}`);
      }
      resolve(out);
    });
  });
}

const queue = [...projects];
const outcomes: Outcome[] = [];
const workers = Array.from({ length: Math.max(1, Math.min(8, os.cpus().length)) }, async () => {
  for (let p = queue.shift(); p; p = queue.shift()) outcomes.push(await cruiseProject(p));
});
await Promise.all(workers);

const cruised = outcomes.reduce((n, o) => n + o.cruised, 0);
const ran = outcomes.filter((o) => o.cruised > 0 || o.errors.length > 0);
const skippedAstro = outcomes.filter((o) => o.skippedAstroOnly);
const unchanged = outcomes.filter((o) => o.skippedUnchanged);
const astroTotal = outcomes.reduce((n, o) => n + o.astroCount, 0);
const layered = outcomes.filter((o) => o.layerRules > 0);
const errors = outcomes.flatMap((o) => o.errors);

const summaryLine =
  `${cruised} module(s) cruised in ${ran.length} workspace(s)` +
  (layered.length > 0 ? `; layer rules active in ${layered.map((o) => o.label).join(', ')}` : '; circular check only (no src/domain|ui|cms|storyblok|worker|pages folders)') +
  (astroTotal > 0 ? `; ${astroTotal} .astro file(s) not cruised (covered by check:imports)` : '') +
  (skippedAstro.length > 0 ? `; ${skippedAstro.length} workspace(s) skipped: only .astro files (covered by check:imports)` : '') +
  (unchanged.length > 0 ? `; ${unchanged.length} unchanged workspace(s) skipped (diff scope)` : '');

for (const e of errors) console.error(`  • ${e}`);
if (cruised === 0 && errors.length === 0 && skippedAstro.length === 0 && unchanged.length === 0) {
  fail(`no ${dirs.join('/')} directory found ${isMonorepo ? 'in any workspace' : 'in the project'}; dependency-cruiser had nothing to cruise. Set \`archDirs\` in guardrails.config.ts.`);
}
if (errors.length > 0) {
  console.error(`  ${summaryLine}`);
  fail(`${errors.length} problem(s) above.`);
}
console.log(`✅ Architecture (dependency-cruiser) passed: ${summaryLine}.`);
