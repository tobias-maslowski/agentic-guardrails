/**
 * Loads the project's `typescript` and verifies it exposes the compiler API these checks rely on.
 * Supported: 5.x and 6.x. Anything else (e.g. the 7.x native rewrite, whose JS API differs) fails once
 * with an actionable message instead of crashing inside a checker (`Cannot read properties of undefined (reading 'Latest')`).
 */

import { SUPPORTED_TS, SUPPORTED_TS_MAJORS } from './ts-support.ts';

export { SUPPORTED_TS, SUPPORTED_TS_MAJORS };

function fail(message: string): never {
  console.error(`❌ ${message}\n   Fix: npm install -D typescript@~5.9   (supported range: ${SUPPORTED_TS})`);
  process.exit(1);
}

let mod: any;
try {
  mod = await import('typescript');
} catch (err) {
  fail(`The "typescript" package could not be loaded (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`);
}

const candidate: any = mod?.default ?? mod;
const version = typeof candidate?.version === 'string' ? candidate.version : 'unknown';
const major = Number.parseInt(version, 10);

if (!Number.isFinite(major) || major < Math.min(...SUPPORTED_TS_MAJORS) || major > Math.max(...SUPPORTED_TS_MAJORS)) {
  fail(`Installed typescript ${version} is outside the supported range ${SUPPORTED_TS}; its compiler API is not compatible with the guardrail checks.`);
}
try {
  const sf = candidate.createSourceFile('probe.ts', 'export const a = 1;', candidate.ScriptTarget.Latest, true);
  if (!sf || typeof candidate.forEachChild !== 'function' || candidate.SyntaxKind?.ImportDeclaration === undefined) {
    throw new Error('compiler API incomplete');
  }
} catch (err) {
  fail(`Installed typescript ${version} does not provide the expected compiler API (${err instanceof Error ? err.message : String(err)}).`);
}

export const ts: typeof import('typescript') = candidate;
