import { execSync } from 'node:child_process';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * Diff-Aware Guardrail Runner (scripts/run-guardrails.ts)
 *
 * 1. Always runs fast static checks (<300ms):
 *    - `npm run check:arch` (dependency-cruiser module boundaries)
 *    - `npm run check:drift` (doc-drift, ADR integrity, .astro boundaries, interactive selector coverage)
 *    - `npm run check:complexity` (AST cognitive/cyclomatic complexity & architectural smell advisor)
 * 2. Conditionally runs `npm run check:visual` (Playwright) ONLY when git reports
 *    changes in `guardrailsConfig.uiTriggerPatterns` (or when `--all` is passed).
 */

function run(cmd: string) {
  execSync(cmd, { stdio: 'inherit' });
}

function getChangedFiles(): string[] {
  try {
    const out = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .flatMap((entry) => entry.split(' -> '));
  } catch {
    return ['src/ui/'];
  }
}

const forceAll = process.argv.includes('--all');

// 1. Fast Static Guardrails & Complexity Advisor (Always Run)
run('npm run check:arch');
run('npm run check:drift');
run('npm run check:complexity');

// 2. Conditional Visual / Behavioral Playwright Guardrail
if (guardrailsConfig.visualSpecPath) {
  const changedFiles = getChangedFiles();
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
