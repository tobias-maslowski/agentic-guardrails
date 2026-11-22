import fs from 'node:fs';

/**
 * Diff-aware scope for the checks (scripts/scope.ts).
 * The runner writes the absolute paths of the changed files plus their transitive importers to the JSON file named by
 * GUARDRAILS_SCOPE_FILE. No variable => full scan. Checks that can be made diff-aware safely call `inScope(abs)`
 * for the files they would report on; everything that cannot stays full.
 */
function load(): Set<string> | null {
  const file = process.env.GUARDRAILS_SCOPE_FILE;
  if (!file) return null;
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? new Set<string>(list.filter((x) => typeof x === 'string')) : null;
  } catch {
    return null; // unreadable scope: fail closed with a full scan
  }
}

const scope = load();
export const isDiffScoped = scope !== null;
export const inScope = (abs: string): boolean => scope === null || scope.has(abs);
export const scopeSize = (): number | null => (scope === null ? null : scope.size);
