import { execSync } from 'node:child_process';
import { guardrailsConfig } from '../guardrails.config.ts';
import { getChangedFiles } from './git-changes.ts';

/**
 * Diff-Aware Guardrail Runner (scripts/run-guardrails.ts)
 *
 * 1. Always runs fast static checks (<300ms):
 *    - `npm run check:arch` (dependency-cruiser module boundaries)
 *    - `npm run check:drift` (doc-drift, ADR integrity, .astro boundaries, interactive selector coverage)
 *    - `npm run check:complexity` (AST cognitive/cyclomatic complexity & architectural smell advisor)
 *    - `npm run check:deps` (Tier 1 fast local banned/wildcard dependency hygiene;
 *      automatically enables Tier 2 `--audit` registry CVE + outdated check when `package.json` or lockfile changes, or `--all`)
 * 2. Conditionally runs `npm run check:visual` (Playwright) ONLY when git reports
 *    changes in `guardrailsConfig.uiTriggerPatterns` (or when `--all` is passed).
 *
 * Flags: `--all` forces every gate; `--base <ref>` also counts files changed in `<ref>...HEAD`
 * (CI / PR checkouts, where the working tree is clean). Without git information every gate runs.
 * Run it from the package directory (also inside an npm workspace); paths are relative to cwd.
 */

// Also matches a root lockfile when running inside an npm workspace (paths come back as ../package-lock.json).
const DEP_FILE_PATTERNS = [/^(\.\.\/)*package\.json$/, /^(\.\.\/)*(package-lock|npm-shrinkwrap)\.json$/];

function run(cmd: string) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    console.error(`\n❌ Guardrail failed: ${cmd}`);
    process.exit(1);
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (i !== -1 && (!value || value.startsWith('-'))) {
    console.error(`❌ ${flag} requires a value.`);
    process.exit(1);
  }
  return value;
}

// Stateful (/g, /y) patterns would alternate between match and miss across calls.
const matchesAny = (patterns: RegExp[], file: string) =>
  patterns.some((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, '')).test(file));

const base = argValue('--base');
const baseArg = base ? ` --base ${JSON.stringify(base)}` : '';
let forceAll = process.argv.includes('--all');
const changedFiles = getChangedFiles({ base });
if (changedFiles === null && !forceAll) {
  // Unknown is not "nothing changed": fail closed by running every gate.
  console.warn('⚠️  Git status unavailable (not a git work tree?). Running all gates as if --all was passed.');
  forceAll = true;
}
const changed = changedFiles ?? [];

// 1. Fast Static Guardrails & Complexity Advisor (Always Run)
run('npm run check:arch');
run('npm run check:drift');
run(`npm run check:complexity --${baseArg}`);

// 2. Dependency Hygiene + Diff-Aware Security & Freshness Audit
const touchedDepFiles = changed.filter((file) => matchesAny(DEP_FILE_PATTERNS, file));
if (forceAll || touchedDepFiles.length > 0) {
  run('node --experimental-strip-types scripts/check-deps.ts --audit');
} else {
  run('node --experimental-strip-types scripts/check-deps.ts');
}

// 3. Conditional Visual / Behavioral Playwright Guardrail
if (guardrailsConfig.visualSpecPath) {
  const touchedUiFiles = changed.filter((file) => matchesAny(guardrailsConfig.uiTriggerPatterns, file));

  if (forceAll || touchedUiFiles.length > 0) {
    const reason = forceAll
      ? '--all flag passed'
      : `UI changes detected (${touchedUiFiles.join(', ')})`;
    console.log(`\n🔍 Triggering Playwright Visual Guardrail [${reason}]...`);
    run('npm run check:visual');
  } else {
    console.log(
      '⚡ Skipping Playwright Visual Guardrail (no UI changes detected in git status). Pass --all to force.'
    );
  }
}
