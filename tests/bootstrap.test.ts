import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SKILL_ROOT, makeProject } from './helpers.ts';

const BOOTSTRAP = path.join(SKILL_ROOT, 'scripts/bootstrap-repo.mjs');
const boot = (...args: string[]) =>
  spawnSync(process.execPath, [BOOTSTRAP, ...args], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));

test('rejects unknown presets and flags without a value', () => {
  const dir = tmp();
  assert.notEqual(boot('--target', dir, '--preset', 'storybloks').status, 0);
  assert.notEqual(boot('--target', '--force').status, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('invalid package.json aborts before writing anything', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{ nope');
  assert.notEqual(boot('--target', dir).status, 0);
  assert.deepEqual(fs.readdirSync(dir), ['package.json']);
});

test('creates a package.json with scripts in an empty target; check:types only for astro', () => {
  const dir = tmp();
  assert.equal(boot('--target', dir).status, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.scripts.guardrails);
  assert.equal(pkg.scripts['check:types'], undefined);

  // check:types is only installed when a tsconfig exists (a script that cannot run would be dead).
  const astro = makeProject({ packageJson: { name: 'a', dependencies: { astro: '^5.0.0' } }, preFiles: { 'tsconfig.json': '{}' } });
  const apkg = JSON.parse(fs.readFileSync(path.join(astro.dir, 'package.json'), 'utf8'));
  assert.equal(apkg.scripts['check:types'], undefined); // no @astrojs/check declared: plain tsc would fail on .astro imports
  astro.cleanup();
  const astroOk = makeProject({ packageJson: { name: 'c', dependencies: { astro: '^5.0.0' }, devDependencies: { '@astrojs/check': '^0.9.0' } }, preFiles: { 'tsconfig.json': '{}' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(astroOk.dir, 'package.json'), 'utf8')).scripts['check:types'], 'astro check && tsc --noEmit');
  astroOk.cleanup();
  const noTs = makeProject({ packageJson: { name: 'b', dependencies: { astro: '^5.0.0' } } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(noTs.dir, 'package.json'), 'utf8')).scripts['check:types'], undefined);
  noTs.cleanup();
});

test('keeps existing differing scripts and warns', () => {
  const p = makeProject({ packageJson: { name: 'a', scripts: { guardrails: 'echo mine' } } });
  const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.guardrails, 'echo mine');
  p.cleanup();
});

test('storyblok preset does not patch an existing config without --force', () => {
  const dir = tmp();
  assert.equal(boot('--target', dir).status, 0);
  const cfg = path.join(dir, 'guardrails.config.ts');
  const before = fs.readFileSync(cfg, 'utf8');
  const r = boot('--target', dir, '--preset', 'storyblok');
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
  assert.match(r.stderr, /Existing guardrails\.config\.ts kept/);
});

test('tsconfig: only exclude is extended; include is untouched; extends-only is skipped', () => {
  const dir = tmp();
  const ts = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(ts, JSON.stringify({ include: ['scripts-entry.ts', 'src'] }));
  assert.equal(boot('--target', dir).status, 0);
  const out = JSON.parse(fs.readFileSync(ts, 'utf8'));
  assert.deepEqual(out.include, ['scripts-entry.ts', 'src']);
  assert.ok(out.exclude.includes('scripts'));

  const dir2 = tmp();
  const ts2 = path.join(dir2, 'tsconfig.json');
  fs.writeFileSync(ts2, JSON.stringify({ extends: './base.json' }));
  const r = boot('--target', dir2);
  assert.equal(JSON.parse(fs.readFileSync(ts2, 'utf8')).exclude, undefined);
  assert.match(r.stderr, /extends another config/);
});
