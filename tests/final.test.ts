import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeMonorepo, makeProject, type Monorepo } from './helpers.ts';

const pj = (o: object) => JSON.stringify(o, null, 2);
const BASE: Record<string, string> = {
  'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*' }, scripts: { build: 'node -e 0', test: 'node --test' } }),
  'apps/web/astro.config.mjs': "export default { output: 'static' };\n",
  'apps/web/src/pages/index.astro': '---\nconst a = 1;\n---\n<p>{a}</p>\n',
  'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts' } }),
  'packages/ui/src/index.ts': 'export const button = 1;\n',
};
const weakCfg = (extra: string) => (c: string) => c.replace(/\n};\s*$/, `\n  ${extra}\n};\n`);

function mono(extra: Record<string, string>, fn: (m: Monorepo) => void, opts: Parameters<typeof makeMonorepo>[1] = {}) {
  const m = makeMonorepo({ ...BASE, ...extra }, opts);
  try {
    fn(m);
  } finally {
    m.cleanup();
  }
}
const setScripts = (m: Monorepo, edit: (s: Record<string, string>) => void) => {
  const f = path.join(m.dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  edit(pkg.scripts);
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2));
};
const guardrails = (m: Monorepo, args: string[] = []) => m.npm(['run', 'guardrails', '--', ...args]);

test('strict bootstrap defaults are not reported as weakened', () => {
  mono({}, (m) => {
    const r = guardrails(m);
    assert.doesNotMatch(r.output, /weakened/i, r.output);
  });
});

test('weakened: a no-op, replaced or deleted gate script is reported; the shipped check still runs directly', () => {
  mono({ 'apps/web/src/pages/bad.astro': "---\nimport x from '../../../../packages/ui/src/index.ts';\n---\n" }, (m) => {
    setScripts(m, (s) => (s['check:imports'] = 'true'));
    const r = guardrails(m);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /"check:imports" script is a no-op/);
    assert.match(r.output, /check:imports: npm script no longer runs the shipped check; ran scripts\/guardrails\/check-imports\.ts directly/);
    assert.match(r.output, /bad\.astro:2/, 'the real check still found the violation');
  });
  mono({}, (m) => {
    setScripts(m, (s) => delete s['check:imports']);
    const r = guardrails(m);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /"check:imports" script is missing/);
  });
  mono({}, (m) => {
    setScripts(m, (s) => (s['check:ssr'] = 'node -e 0'));
    assert.match(guardrails(m).output, /"check:ssr" no longer runs the shipped check-ssr\.ts/);
  });
  mono({}, (m) => {
    setScripts(m, (s) => (s.build = ':'));
    assert.match(guardrails(m).output, /"build" script is a no-op/);
  });
});

const GATE = {
  'apps/web/src/middleware.ts': "export const onRequest = async (c, next) => {\n  if (c.request.headers.get('x-key') !== c.locals.secret) return new Response('Forbidden', { status: 403 });\n  return next();\n};\n",
};
const WRANGLER = (rwf: string) => `{ "name": "web", "assets": { "directory": "./dist/client"${rwf} } }\n`;

test('check:gate: every wrangler config with assets needs run_worker_first; any 4xx counts as a gate; generated dist config is ignored', () => {
  mono({ ...GATE, 'apps/web/wrangler.jsonc': `// c\n${WRANGLER(', "run_worker_first": true')}`, 'apps/web/wrangler.test.toml': '[assets]\ndirectory = "./dist"\n' }, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /wrangler\.test\.toml:1[\s\S]*run_worker_first/);
    assert.doesNotMatch(r.output, /wrangler\.jsonc:1/);
  });
  mono({ ...GATE, 'apps/web/wrangler.jsonc': WRANGLER(', "run_worker_first": true'), 'apps/web/dist/server/wrangler.json': WRANGLER('') }, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /dist\/server\/wrangler\.json:1/, 'built output is never a source for gate detection');
  });
  mono({ ...GATE, 'apps/web/wrangler.jsonc': WRANGLER(', "run_worker_first": true') }, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /no gate-smoke Playwright spec/);
  });
});

test('check:gate: requireGate fails without a detected gate; config gate.file/status override detection; smoke spec silences the advisory', () => {
  const noGate = { 'apps/web/wrangler.jsonc': WRANGLER(', "run_worker_first": true'), 'apps/web/src/middleware.ts': 'export const onRequest = (c, next) => next();\n' };
  mono(noGate, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /no site-wide access gate detected[\s\S]*fix:/);
  });
  mono(noGate, (m) => assert.equal(m.run('check-gate.ts').status, 0), { config: weakCfg('requireGate: false,') });
  mono(
    { 'apps/web/wrangler.jsonc': WRANGLER(''), 'apps/web/src/guard.ts': 'export const g = () => new Response("nope", { status: 418 });\n' },
    (m) => {
      const r = m.run('check-gate.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /bypassed for static assets/);
    },
    { config: weakCfg("gate: { file: 'apps/web/src/guard.ts', status: 418 },") }
  );
  mono(
    {
      ...GATE,
      'apps/web/wrangler.jsonc': WRANGLER(', "run_worker_first": true'),
      'apps/web/tests/gate.spec.ts': "import { test } from '@playwright/test';\n// uses dist/server/wrangler.json\ntest('asset', async () => { await fetch('/_astro/app.css'); });\n",
    },
    (m) => {
      const r = m.run('check-gate.ts');
      assert.equal(r.status, 0, r.output);
      assert.doesNotMatch(r.output, /no gate-smoke/);
    }
  );
});

test('runner runs check:gate when the script was never bootstrapped, and says so', () => {
  mono({ ...GATE, 'apps/web/wrangler.jsonc': WRANGLER('') }, (m) => {
    setScripts(m, (s) => delete s['check:gate']);
    const r = guardrails(m);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /check:gate: no npm script; ran scripts\/guardrails\/check-gate\.ts directly/);
    assert.match(r.output, /bypassed for static assets/);
  });
});

test('gate-smoke template asserts keyed 200 vs unkeyed 404 on a real asset', () => {
  const t = fs.readFileSync(path.join(import.meta.dirname, '../resources/templates/playwright.protected.gate-smoke.spec.ts'), 'utf8');
  assert.match(t, /toBe\(404\)/);
  assert.match(t, /toBe\(200\)/);
  assert.match(t, /dist\/server\/wrangler\.json/);
  assert.match(t, /GATE_ASSET_PATH/);
});

test('visual gate fails on 0 tests, all skipped or no tests found, and prints "N passed, M skipped"', () => {
  const run = (visual: string, extra: Record<string, string> = {}) => {
    let out = { status: 0 as number | null, output: '' };
    mono(
      { 'tests/visual.spec.ts': "import { test } from '@playwright/test';\ntest('x', () => {});\n", 'scripts/guardrails/check-deps.ts': "console.log('✅ deps stub');\n", ...extra },
      (m) => {
        setScripts(m, (s) => (s['check:visual'] = visual));
        const r = guardrails(m, ['--all']);
        out = { status: r.status, output: r.output };
      },
      { config: weakCfg("visualSpecPath: 'tests/visual.spec.ts',") }
    );
    return out;
  };
  const ok = run(`node -e "console.log('  2 passed (1s)\\n  1 skipped')" --`);
  assert.doesNotMatch(ok.output, /Guardrail failed: npm run check:visual/, ok.output);
  assert.match(ok.output, /2 passed, 1 skipped/);
  const zero = run(`node -e "console.log('Running 0 tests')" --`);
  assert.match(zero.output, /Guardrail failed: npm run check:visual/);
  assert.match(zero.output, /no passing tests/);
  const skipped = run(`node -e "console.log('  3 skipped')" --`);
  assert.match(skipped.output, /all 3 skipped/);
  const none = run(`node -e "console.error('Error: No tests found')" --`);
  assert.match(none.output, /found no tests/);
});

test('visual gate failure output drops browser-install banners and is capped at ~25 lines unless --verbose', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `failure line ${i}`).join('\\n');
  const stub = `node -e "console.log('Looks like Playwright was just installed\\nnpx playwright install\\n${lines}\\n1 failed');process.exit(1)" --`;
  mono(
    { 'tests/visual.spec.ts': "import { test } from '@playwright/test';\ntest('x', () => {});\n", 'scripts/guardrails/check-deps.ts': "console.log('✅');\n" },
    (m) => {
      setScripts(m, (s) => (s['check:visual'] = stub));
      const r = guardrails(m, ['--all']);
      assert.doesNotMatch(r.output, /Looks like Playwright|npx playwright install/);
      assert.match(r.output, /failure line 0/);
      assert.doesNotMatch(r.output, /failure line 39/);
      assert.match(r.output, /more line\(s\) \(use --verbose\)/);
      assert.match(guardrails(m, ['--all', '--verbose']).output, /failure line 39/);
    },
    { config: weakCfg("visualSpecPath: 'tests/visual.spec.ts',") }
  );
});

const weakCases: Array<[string, string, RegExp, Record<string, string>?]> = [
  ['externalRules narrowed for a pure package', "externalRules: [{ workspaces: ['packages/domain'], forbid: ['node:*'] }],", /externalRules narrowed: packages\/domain is not forbidden from importing cloudflare:\*, astro:\*/, { 'packages/domain/package.json': pj({ name: '@m/domain', version: '1.0.0', exports: { '.': './src/index.ts' } }), 'packages/domain/src/index.ts': 'export const d = 1;\n' }],
  ['requireAdr false', 'requireAdr: false,', /requireAdr is false/],
  ['requireStoryblokEditable false', 'storyblok: { wrapperDir: "src/storyblok", requireStoryblokEditable: false },', /requireStoryblokEditable is false/],
  ['ratchet on', 'ratchetChangedFilesOnly: true,', /ratchet is on/],
  ['single layer', "layers: [{ name: 'all', workspaces: ['apps/*', 'packages/*'] }],", /single layer/],
  ['any raised threshold', 'thresholds: { functionCognitive: 16, functionCyclomatic: 12, astroScriptMaxStatements: 25, astroScriptMaxCognitive: 12 },', /thresholds\.functionCognitive is 16 \(default 15\)/],
];
for (const [name, extra, re, files] of weakCases) {
  test(`weakened config detects: ${name}`, () => {
    mono(files ?? {}, (m) => {
      const r = guardrails(m);
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, re);
    }, { config: weakCfg(extra) });
  });
}

test('weakened config: lowered thresholds are fine; uiTriggerPatterns matching no interactive file are reported', () => {
  mono({}, (m) => {
    assert.doesNotMatch(guardrails(m).output, /thresholds\./);
  }, { config: weakCfg('thresholds: { functionCognitive: 5, functionCyclomatic: 5, astroScriptMaxStatements: 10, astroScriptMaxCognitive: 5 },') });
  mono(
    { 'apps/web/src/components/Menu.astro': '<button id="m">x</button>\n<script>document.getElementById("m")?.click();</script>\n', 'tests/visual.spec.ts': "import { test } from '@playwright/test';\ntest('m', () => {});\n" },
    (m) => {
      const r = guardrails(m);
      assert.match(r.output, /uiTriggerPatterns match none of 1 interactive file\(s\), e\.g\. apps\/web\/src\/components\/Menu\.astro/);
    },
    { config: weakCfg("visualSpecPath: 'tests/visual.spec.ts', uiTriggerPatterns: [/^docs\\//],") }
  );
});

test('package-lock.json change: offline deps checks run and a one-line reminder points to --all', () => {
  mono({ 'scripts/guardrails/check-deps.ts': "console.log('✅ deps stub');\n" }, (m) => {
    const sh = (...a: string[]) => require_git(m.dir, a);
    sh('init', '-q');
    sh('add', '-A');
    sh('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'i');
    m.write('package-lock.json', '{}\n');
    const r = guardrails(m);
    assert.match(r.output, /package-lock\.json changed: only the offline dependency checks ran; run `npm run guardrails -- --all`/);
  });
});
function require_git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

test('check:caching is AST based: comment-only, unrelated-branch and non-response literals do not count; same-branch and worker wrappers do', () => {
  const page = (body: string) => ({ 'apps/web/src/pages/api/a.ts': body });
  mono(page("// 'Cache-Control': 'private'\nconst note = \"Cache-Control: no-store\";\nexport const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n"), (m) => assert.equal(m.run('check-caching.ts').status, 1));
  mono(
    page("export const GET = ({ cookies, url }) => {\n  const headers = new Headers();\n  if (url.pathname === '/x') headers.set('Cache-Control', 'no-store');\n  const v = cookies.get('s')?.value;\n  return new Response(v, { headers });\n};\n"),
    (m) => assert.equal(m.run('check-caching.ts').status, 1)
  );
  mono(
    page("export const GET = ({ cookies }) => {\n  const v = cookies.get('s')?.value;\n  if (v) {\n    return new Response(v, { headers: { 'Cache-Control': 'private' } });\n  }\n  return new Response('');\n};\n"),
    (m) => assert.equal(m.run('check-caching.ts').status, 0)
  );
  mono(
    { ...page("export const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n"), 'apps/web/src/middleware.ts': "export const onRequest = async (c, next) => {\n  const res = await next();\n  if (c.url.pathname === '/x') res.headers.set('Cache-Control', 'no-store');\n  return res;\n};\n" },
    (m) => assert.equal(m.run('check-caching.ts').status, 1, 'a conditional middleware write does not cover all routes')
  );
  mono(
    { ...page("export const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n"), 'apps/web/src/worker.ts': "export default { async fetch(r, env) { const res = await env.ASSETS.fetch(r); const out = new Response(res.body, res); out.headers.append('Cache-Control', 'private, no-store'); return out; } };\n" },
    (m) => assert.equal(m.run('check-caching.ts').status, 0)
  );
  mono(
    page("export const GET = ({ cookies }) => new Response(cookies.get('s')?.value, { headers: [['Cache-Control', 'no-store']] });\n"),
    (m) => assert.equal(m.run('check-caching.ts').status, 0)
  );
});

test('bootstrap --force writes guardrails.config.ts.bak and keeps an existing visualSpecPath', () => {
  mono(
    { 'tests/visual.spec.ts': "import { test } from '@playwright/test';\ntest('x', () => {});\n" },
    (m) => {
      const cfgPath = path.join(m.dir, 'guardrails.config.ts');
      const before = fs.readFileSync(cfgPath, 'utf8');
      assert.match(before, /visualSpecPath: 'tests\/visual\.spec\.ts'/);
      const r = spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/bootstrap-repo.mjs'), '--target', m.dir, '--force'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(`${cfgPath}.bak`, 'utf8'), before);
      assert.match(fs.readFileSync(cfgPath, 'utf8'), /visualSpecPath: 'tests\/visual\.spec\.ts'/);
    },
    { config: (c) => c.replace(/visualSpecPath:\s*null/, "visualSpecPath: 'tests/visual.spec.ts'") }
  );
});
test('bootstrap reconciles a pristine CI workflow (adds the Playwright step) and only hints for a modified one; no dependency-cruiser hint when installed', () => {
  const p = makeProject({ packageJson: { name: 'ci', type: 'module', devDependencies: { 'dependency-cruiser': '^16.0.0' } } });
  try {
    const wf = path.join(p.dir, '.github/workflows/guardrails.yml');
    const original = fs.readFileSync(wf, 'utf8');
    assert.doesNotMatch(original, /playwright install/);
    const reboot = (extra: string[] = []) => spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/bootstrap-repo.mjs'), '--target', p.dir, ...extra], { encoding: 'utf8' });
    const manifest = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
    manifest.devDependencies['@playwright/test'] = '^1.50.0';
    fs.writeFileSync(path.join(p.dir, 'package.json'), JSON.stringify(manifest));
    const r1 = reboot();
    assert.match(fs.readFileSync(wf, 'utf8'), /npx playwright install --with-deps chromium/);
    assert.doesNotMatch(r1.stdout, /Next: npm install -D dependency-cruiser/);
    fs.writeFileSync(wf, original.replace('node-version: 22', 'node-version: 24'));
    const r2 = reboot();
    assert.doesNotMatch(fs.readFileSync(wf, 'utf8'), /playwright install/);
    assert.match(r2.stdout, /modified by you and has no `npx playwright install/);
  } finally {
    p.cleanup();
  }
});

test('check:drift: co-located test files in a scoped module need no Exported Modules entry', () => {
  const p = makeProject({ packageJson: { name: 'd', type: 'module' } });
  try {
    p.write('src/domain/a.ts', 'export const a = 1;\n');
    p.write('src/domain/a.test.ts', "import test from 'node:test';\ntest('a', () => {});\n");
    p.write('src/domain/AGENTS.md', '# Domain\n\n## Purpose\nx\n\n## Exported Modules\n- `a.ts`\n');
    const r = p.run('check-doc-drift.ts');
    assert.doesNotMatch(r.output, /a\.test\.ts/, r.output);
  } finally {
    p.cleanup();
  }
});
