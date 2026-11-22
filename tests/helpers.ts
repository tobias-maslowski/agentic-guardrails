import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(HERE, '..');

export interface Project {
  dir: string;
  write(rel: string, content: string): void;
  run(script: string, args?: string[], env?: NodeJS.ProcessEnv): RunResult;
  cleanup(): void;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * Creates a temp project, bootstraps the skill into it, and returns helpers.
 * `typescript` is symlinked from the harness so check-complexity.ts can import it.
 */
export function makeProject(
  opts: { preset?: 'standard' | 'storyblok'; git?: boolean; packageJson?: object | null } = {}
): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  if (opts.packageJson !== null) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(opts.packageJson ?? { name: 'fixture', type: 'module' }, null, 2)
    );
  }
  const args = [path.join(SKILL_ROOT, 'scripts/bootstrap-repo.mjs'), '--target', dir];
  if (opts.preset) args.push('--preset', opts.preset);
  const boot = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (boot.status !== 0) throw new Error(`bootstrap failed:\n${boot.stdout}\n${boot.stderr}`);

  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(SKILL_ROOT, 'node_modules/typescript'),
    path.join(dir, 'node_modules/typescript'),
    'dir'
  );
  if (opts.git) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  }

  return {
    dir,
    write(rel, content) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    run(script, args = [], env = {}) {
      const r = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', path.join(dir, 'scripts', script), ...args],
        { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }
      );
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: r.stdout + r.stderr };
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
