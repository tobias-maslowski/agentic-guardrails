import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeProject, type Project } from './helpers.ts';

// Stubs keep the shipped file name in the script so the runner treats them as the real gate scripts.
const STUBS = { 'check:arch': 'node -e 0 -- check-arch.ts', 'check:drift': 'node -e 0 -- check-doc-drift.ts', 'check:complexity': 'node -e 0 -- check-complexity.ts' };
// check-deps and check:visual are stubbed so the runner's decisions are observable without network.
function runnerProject(git: boolean): Project {
  const log = `node -e "require('fs').appendFileSync('calls.log','visual\\n');console.log('1 passed')" --`;
  const p = makeProject({
    git,
    packageJson: {
      name: 'r',
      type: 'module',
      scripts: { ...STUBS, 'check:visual': log },
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
  const local = p.run('run-guardrails.ts');
  assert.equal(local.status, 0, local.output);
  assert.doesNotMatch(calls(p), /visual/);
  assert.match(local.output, /Skipped slow tier[^\n]*check:visual/);
  assert.equal(p.run('run-guardrails.ts', [], { CI: 'true' }).status, 0);
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
  const withBase = p.run('run-guardrails.ts', ['--base', 'main'], { CI: 'true' });
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
  assert.doesNotMatch(calls(p), /--audit/, 'local run is offline-only');
  p.run('run-guardrails.ts', [], { CI: 'true' });
  assert.match(calls(p), /deps --audit/);

  const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
  pkg.scripts['check:drift'] = 'node -e "process.exit(3)" -- check-doc-drift.ts';
  p.write('package.json', JSON.stringify(pkg));
  const r = p.run('run-guardrails.ts');
  assert.equal(r.status, 1);
  assert.match(r.output, /Guardrail failed: npm run check:drift/);
  p.cleanup();
});

// ---------- tiers, scope, quiet output, cache ----------

function tierProject(extraScripts: Record<string, string> = {}): Project {
  const p = makeProject({
    git: true,
    packageJson: {
      name: 't',
      type: 'module',
      scripts: { ...STUBS, build: "node -e \"require('fs').appendFileSync('calls.log','build\\n')\"", ...extraScripts },
    },
  });
  p.write('.gitignore', 'node_modules\n');
  p.write('scripts/check-deps.ts', "console.log('✅ deps stub');\n");
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'init');
  return p;
}

test('slow tier (build) is skipped locally with one explanatory line; --all and CI run it', () => {
  const p = tierProject();
  const local = p.run('run-guardrails.ts', ['--no-cache']);
  assert.equal(local.status, 0, local.output);
  assert.doesNotMatch(calls(p), /build/);
  assert.match(local.output, /Skipped slow tier[^\n]*--all or CI=true[^\n]*build/);
  assert.match(local.output, /total \d+ms \(fast tier checks \d+ms, budget 10000ms\)/);
  assert.match(local.output, /✅ npm run check:arch\s+\d+ms/);
  assert.equal(p.run('run-guardrails.ts', ['--all']).status, 0);
  assert.match(calls(p), /build/);
  p.cleanup();
});

test('failure output is capped at 20 findings unless --verbose; passing checks print one line', () => {
  const many = Array.from({ length: 25 }, (_, i) => `console.error('  • f${i}.ts:1  bad\\n      fix: x');`).join('');
  const p = tierProject({ 'check:drift': `node -e "${many.replace(/"/g, '\\"')}process.exit(1)" -- check-doc-drift.ts` });
  const r = p.run('run-guardrails.ts', ['--no-cache']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /f19\.ts/);
  assert.doesNotMatch(r.output, /f20\.ts/);
  assert.match(r.output, /\+\d+ more (finding|line)\(s\) \(use --verbose\)/);
  const v = p.run('run-guardrails.ts', ['--no-cache', '--verbose']);
  assert.match(v.output, /f24\.ts/);
  p.cleanup();
});

test('unchanged inputs are served from .guardrails-cache; an edit invalidates it; --no-cache bypasses it', () => {
  const p = tierProject();
  const first = p.run('run-guardrails.ts');
  assert.doesNotMatch(first.output, /cached/);
  const second = p.run('run-guardrails.ts');
  assert.match(second.output, /⏩ npm run check:arch\s+cached/);
  assert.doesNotMatch(p.run('run-guardrails.ts', ['--no-cache']).output, /cached/);
  p.write('README.md', '# changed\n');
  assert.doesNotMatch(p.run('run-guardrails.ts').output, /cached/);
  p.cleanup();
});

test('diff scope: a clean tree scans everything, an edit scans only the file and its importers; config edits force a full scan', () => {
  const p = tierProject();
  assert.match(p.run('run-guardrails.ts', ['--no-cache']).output, /full scan \(clean tree/);
  p.write('src/a.ts', "export const a = 1;\n");
  git(p, 'add', '-A');
  git(p, 'commit', '-qm', 'a');
  p.write('src/a.ts', "export const a = 2;\n");
  const scoped = p.run('run-guardrails.ts', ['--no-cache']);
  assert.match(scoped.output, /diff scope: 1 changed file\(s\), 1 with importers/);
  p.write('src/b.ts', "import { a } from './a.ts';\nexport const b = a;\n");
  assert.match(p.run('run-guardrails.ts', ['--no-cache']).output, /diff scope: 2 changed file\(s\), 2 with importers/);
  p.write('tsconfig.json', '{}');
  assert.match(p.run('run-guardrails.ts', ['--no-cache']).output, /full scan \(tsconfig\.json changed\)/);
  p.cleanup();
});
