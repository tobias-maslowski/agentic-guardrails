import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SKILL_ROOT } from './helpers.ts';

const install = (home: string) =>
  spawnSync('bash', [path.join(SKILL_ROOT, 'install-global-skill.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });

test('links all three clients and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  for (let i = 0; i < 2; i++) assert.equal(install(home).status, 0);
  for (const sub of ['.claude/skills', '.gemini/config/skills', '.copilot/skills']) {
    assert.equal(fs.realpathSync(path.join(home, sub, 'agentic-guardrails')), fs.realpathSync(SKILL_ROOT));
  }
});

test('refuses to nest a link inside an existing real directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const real = path.join(home, '.claude/skills/agentic-guardrails');
  fs.mkdirSync(real, { recursive: true });
  const r = install(home);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readdirSync(real).length, 0);
});
