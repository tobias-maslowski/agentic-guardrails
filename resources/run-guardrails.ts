import { execSync } from 'node:child_process';
import { guardrailsConfig } from '../guardrails.config.ts';

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
 */

const DEP_FILE_PATTERNS = [/^package\.json$/, /^package-lock\.json$/];

function run(cmd: string) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    console.error(`\n❌ Guardrail failed: ${cmd}`);
    process.exit(1);
  }
}

function getChangedFiles(): string[] {
  try {
    // -z: NUL-separated, unquoted paths; renames emit "XY new\0old\0"
    const out = execSync('git status --porcelain -z', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parts = out.split('\0').filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      files.push(parts[i].slice(3));
      if (/^[RC]/.test(parts[i])) files.push(parts[++i]);
    }
    return files;
  } catch {
    // Not a git repo: no diff information, so only run the always-on checks.
    return [];
  }
}

const forceAll = process.argv.includes('--all');
const changedFiles = getChangedFiles();

// 1. Fast Static Guardrails & Complexity Advisor (Always Run)
run('npm run check:arch');
run('npm run check:drift');
run('npm run check:complexity');

// 2. Dependency Hygiene + Diff-Aware Security & Freshness Audit
const touchedDepFiles = changedFiles.filter((file) =>
  DEP_FILE_PATTERNS.some((pattern) => pattern.test(file))
);
if (forceAll || touchedDepFiles.length > 0) {
  run('node --experimental-strip-types scripts/check-deps.ts --audit');
} else {
  run('node --experimental-strip-types scripts/check-deps.ts');
}

// 3. Conditional Visual / Behavioral Playwright Guardrail
if (guardrailsConfig.visualSpecPath) {
  const touchedUiFiles = changedFiles.filter((file) =>
    guardrailsConfig.uiTriggerPatterns.some((pattern) => pattern.test(file))
  );

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
