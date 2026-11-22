import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageWorkspaceGlobs, resolveWorkspaceGlobs } from './workspace-globs.ts';

/**
 * Shared project context (installed next to the checks): locates `guardrails.config.ts`, derives the repo
 * root from it and resolves the workspace list (npm workspaces monorepo mode) from `config.workspaces`.
 * Single-package repos have exactly one "project" (the root).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_CANDIDATES = [
  path.resolve(HERE, '..', 'guardrails.config.ts'), // single package: scripts/
  path.resolve(HERE, '..', '..', 'guardrails.config.ts'), // monorepo: scripts/guardrails/
];
const configPath = CONFIG_CANDIDATES.find((p) => fs.existsSync(p));
if (!configPath) {
  console.error('❌ guardrails.config.ts not found next to the scripts directory. Re-run the bootstrapper.');
  process.exit(1);
}

export const ROOT: string = path.dirname(configPath);
export const guardrailsConfig: any = (await import(pathToFileURL(configPath).href)).guardrailsConfig;

export const toPosix = (p: string): string => p.split(path.sep).join('/');

export interface Project {
  /** POSIX path relative to ROOT ('' for the root itself). */
  dir: string;
  abs: string;
  name: string;
  pkg: Record<string, any>;
}

export function readJson(file: string): Record<string, any> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export { resolveWorkspaceGlobs, packageWorkspaceGlobs };

export const isMonorepo: boolean = Array.isArray(guardrailsConfig.workspaces);

function discoverProjects(): Project[] {
  if (!isMonorepo) {
    const pkg = readJson(path.join(ROOT, 'package.json')) ?? {};
    return [{ dir: '', abs: ROOT, name: pkg.name ?? path.basename(ROOT), pkg }];
  }
  const dirs = resolveWorkspaceGlobs(ROOT, guardrailsConfig.workspaces);
  const list: Project[] = [];
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    const pkg = readJson(path.join(abs, 'package.json'));
    if (!pkg) {
      problems.push(`${dir}/package.json is not valid JSON`);
      continue;
    }
    const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : dir;
    if (seen.has(name)) problems.push(`workspaces "${seen.get(name)}" and "${dir}" share the package name "${name}"`);
    seen.set(name, dir);
    list.push({ dir, abs, name, pkg });
  }
  if (list.length === 0) {
    problems.push(
      `guardrails.config.ts \`workspaces\` (${JSON.stringify(guardrailsConfig.workspaces)}) matched no directory with a package.json`
    );
  }
  if (problems.length > 0) {
    console.error('❌ Workspace discovery failed:\n' + problems.map((p) => `  • ${p}`).join('\n'));
    process.exit(1);
  }
  return list;
}

/** Workspaces in monorepo mode, otherwise the single root project. */
export const projects: Project[] = discoverProjects();

export const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function declaredDeps(pkg: Record<string, any>, sections: readonly string[] = DEP_SECTIONS): Set<string> {
  const names = new Set<string>();
  for (const s of sections) {
    const section = pkg?.[s];
    if (section && typeof section === 'object' && !Array.isArray(section)) for (const n of Object.keys(section)) names.add(n);
  }
  return names;
}

/** Marks a doc/workspace-relative name to display: `apps/web` or '.' for the root. */
export const label = (p: Project): string => p.dir || '.';
