/**
 * Single source of truth for the guardrail defaults. The runner and the weakened-config check compare the
 * effective `guardrails.config.ts` against these values; every deviation is listed by key.
 */
export const DEFAULT_THRESHOLDS = {
  functionCognitive: 15,
  functionCyclomatic: 12,
  astroScriptMaxStatements: 25,
  astroScriptMaxCognitive: 12,
};

export const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

export function defaultRequiredGates(monorepo: boolean): string[] {
  return ['check:arch', 'check:drift', 'check:complexity', 'check:deps', ...(monorepo ? ['check:imports', 'check:caching'] : [])];
}

export function defaultOptionalGates(monorepo: boolean): string[] {
  return ['check:ssr', 'check:gate', ...(monorepo ? [] : ['check:caching']), 'build', 'check:types', 'typecheck', 'test'];
}
