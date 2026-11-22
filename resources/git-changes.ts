import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Shared changed-file detection (installed as scripts/git-changes.ts).
 *
 * Paths are returned relative to `cwd` with forward slashes. Files outside `cwd`
 * (e.g. a root `package-lock.json` when run inside an npm workspace) are returned
 * as `../...` so callers can match them explicitly. Returns `null` when git is
 * unavailable or `cwd` is not inside a work tree, so callers can fail closed
 * instead of treating "unknown" as "nothing changed".
 */

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    files.push(entry.slice(3));
    // Rename/copy entries are followed by the original path as a separate record.
    if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) files.push(parts[++i]);
  }
  return files.filter(Boolean);
}

export interface ChangedFilesOptions {
  cwd?: string;
  /** Also include files changed between `<base>...HEAD` (for CI / PR checkouts). */
  base?: string;
}

export function getChangedFiles(options: ChangedFilesOptions = {}): string[] | null {
  const cwd = options.cwd ?? process.cwd();
  try {
    const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
    const rel = (repoRelative: string) =>
      path.relative(cwd, path.join(top, repoRelative)).split(path.sep).join('/');

    // `-z` gives unquoted NUL-separated paths; `-uall` expands untracked directories.
    const files = parsePorcelainZ(git(['status', '--porcelain', '-z', '-uall'], cwd)).map(rel);

    if (options.base) {
      const diff = git(['diff', '--name-only', '-z', `${options.base}...HEAD`], cwd);
      files.push(...diff.split('\0').filter(Boolean).map(rel));
    }
    return Array.from(new Set(files));
  } catch {
    return null;
  }
}
