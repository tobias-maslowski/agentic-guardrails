import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeProject, type Project } from './helpers.ts';

// check-deps and check:visual are stubbed so the runner's decisions are observable without network.
function runnerProject(git: boolean): Project {
  const noop = 'node -e 0';
  const log = `node -e "require('fs').appendFileSync('calls.log','visual\\n')"`;
  const p = makeProject({
    git,
    packageJson: {
      name: 'r',
      type: 'module',
      scripts: { 'check:arch': noop, 'check:drift': noop, 'check:complexity': 'node -e 0 --', 'check:visual': log },
    },
  });
  p.write(
    'scripts/check-deps.ts',
    "import fs from 'node:fs';\nfs.appendFileSync('calls.log', 'deps ' + process.argv.slice(2).join(' ') + '\\n');\n"
  );
  p.write(
    'guardrails.config.ts',
    fs
      .readFileSync(path.join(p.dir, 'guardrails.config.ts'), 'utf8')
      .replace('visualSpecPath: null', "visualSpecPath: 'tests/visual.spec.ts'")
  );
  return p;
}
const calls = (p: Project) => {
  const f = path.join(p.dir, 'calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const git = (p: Project, ...a: string[]) => spawnSync('git', a, { cwd: p.dir, encoding: 'utf8' });

test('without git, every gate runs (fail closed)', () => {
  const p = runnerProject(false);
  const r = p.run('run-guardrails.ts');
  assert.equal(r.status, 0, r.output);
  assert.match(calls(p), /deps --audit/);
  assert.match(calls(p), /visual/);
  p.cleanup();
});

test('clean git tree skips audit and visual; new untracked ui dir and spaced names trigger visual', () => {
  const p = runnerProject(true);
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'init');
  assert.equal(p.run('run-guardrails.ts').status, 0);
  assert.doesNotMatch(calls(p), /visual|--audit/);

  p.write('src/ui/new dir/Button.astro', '<button>x</button>');
  assert.equal(p.run('run-guardrails.ts').status, 0);
  assert.match(calls(p), /visual/);
  p.cleanup();
});

test('--base picks up committed changes on a clean tree', () => {
  const p = runnerProject(true);
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'init');
  git(p, 'branch', '-M', 'main');
  git(p, 'checkout', '-qb', 'feature');
  p.write('src/ui/A.astro', '<button>x</button>');
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'ui');
  const plain = p.run('run-guardrails.ts');
  assert.equal(plain.status, 0, plain.output);
  assert.doesNotMatch(calls(p), /visual/);
  const withBase = p.run('run-guardrails.ts', ['--base', 'main']);
  assert.equal(withBase.status, 0, withBase.output);
  assert.match(calls(p), /visual/);
  p.cleanup();
});

test('a package.json edit triggers the audit; failing gate exits 1 with a message', () => {
  const p = runnerProject(true);
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'init');
  p.write('package.json', fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8') + '\n');
  p.run('run-guardrails.ts');
  assert.match(calls(p), /deps --audit/);

  const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
  pkg.scripts['check:drift'] = 'node -e "process.exit(3)"';
  p.write('package.json', JSON.stringify(pkg));
  const r = p.run('run-guardrails.ts');
  assert.equal(r.status, 1);
  assert.match(r.output, /Guardrail failed: npm run check:drift/);
  p.cleanup();
});
