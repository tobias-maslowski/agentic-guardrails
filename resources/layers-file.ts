import fs from 'node:fs';

/**
 * Reads an existing layers file (config `layersFile`, e.g. scripts/module-layers.json) so a repo that already
 * documents its layering does not need a second copy in guardrails.config.ts. Accepted shapes (low -> high):
 *   { "layers": [ { "name": "foundation", "workspaces" | "members" | "packages": ["a", "b"], "devOnly": true } ] }
 *   { "layers": [ ["a", "b"], ["c"] ] }
 *   { "layers": { "foundation": ["a"], "apps": ["c"] } }   (object key order = low -> high)
 *   { "foundation": ["a"], "apps": ["c"] }                  (top-level name -> array; `_`-prefixed keys are comments)
 * `devOnly: true` marks a tier (mocks, tooling, test utilities) that may be depended on only through
 * devDependencies/peerDependencies, never as a runtime dependency; it is otherwise an ordinary layer by position.
 * Members are package names, workspace directories, `*` globs, or the bare directory name (`client` = `packages/client`).
 * Any other shape throws with a message naming the accepted shapes.
 */
export interface LoadedLayer {
  name: string;
  patterns: string[];
  devOnly: boolean;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');

export function parseLayers(raw: unknown, file: string): LoadedLayer[] {
  const bad = (why: string): never => {
    throw new Error(
      `${file}: unknown layers shape (${why}). Accepted: { layers: [{ name, workspaces|members|packages: string[], devOnly? }] }, { layers: [string[], ...] } or an object name -> string[] (low -> high).`
    );
  };
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  let list: unknown = top && 'layers' in top ? top.layers : top ?? raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    list = Object.entries(list as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('_'))
      .map(([name, v]) => (isStrings(v) ? { name, workspaces: v } : { name, ...(v as object) }));
  }
  if (!Array.isArray(list) || list.length === 0) return bad('expected a non-empty list of layers');
  return list.map((entry, i): LoadedLayer => {
    if (isStrings(entry)) return { name: `layer ${i + 1}`, patterns: entry, devOnly: false };
    const e = entry as Record<string, unknown> | null;
    const members = e && (isStrings(e.workspaces) ? e.workspaces : isStrings(e.members) ? e.members : isStrings(e.packages) ? e.packages : null);
    if (!e || typeof e !== 'object' || !members) return bad(`layer ${i + 1} has no non-empty workspaces/members/packages array`);
    return { name: typeof e.name === 'string' ? e.name : `layer ${i + 1}`, patterns: members, devOnly: e.devOnly === true };
  });
}

export function loadLayersFile(file: string): LoadedLayer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: cannot read layers file (${err instanceof Error ? err.message : String(err)}).`);
  }
  return parseLayers(raw, file);
}
