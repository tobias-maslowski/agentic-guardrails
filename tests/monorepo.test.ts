import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SKILL_ROOT, makeMonorepo, type Monorepo } from './helpers.ts';

const pj = (o: object) => JSON.stringify(o, null, 2);
const BASE: Record<string, string> = {
  'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*' }, scripts: { build: 'node -e 0', test: 'node --test' } }),
  'apps/web/src/index.ts': "import { button } from '@m/ui';\nexport const a = button;\n",
  'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts', './button': './src/button.ts' } }),
  'packages/ui/src/index.ts': "export const button = 1;\n",
  'packages/ui/src/button.ts': "export const b = 1;\n",
};

function mono(extra: Record<string, string> = {}, opts: Parameters<typeof makeMonorepo>[1] = {}, fn?: (m: Monorepo) => void) {
  const m = makeMonorepo({ ...BASE, ...extra }, opts);
  try {
    fn?.(m);
  } finally {
    if (fn) m.cleanup();
  }
  return m;
}

test('bootstrap at a monorepo root installs ONE copy, root router and root scripts', () => {
  mono({ 'apps/web/README.md': '# web\n' }, {}, (m) => {
    const files = fs.readdirSync(path.join(m.dir, 'scripts/guardrails'));
    for (const f of ['check-imports.ts', 'check-ssr.ts', 'context.ts', 'run-guardrails.ts']) assert.ok(files.includes(f), f);
    assert.ok(!fs.existsSync(path.join(m.dir, 'apps/web/scripts')));
    assert.ok(!fs.existsSync(path.join(m.dir, 'apps/web/AGENTS.md')));
    const pkg = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8'));
    for (const s of ['guardrails', 'check:arch', 'check:drift', 'check:complexity', 'check:deps', 'check:imports']) assert.ok(pkg.scripts[s], s);
    assert.equal(pkg.scripts['check:visual'], undefined); // no Playwright: no dead script
    const agents = fs.readFileSync(path.join(m.dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /`apps\/web\/`.*`apps\/web\/README\.md`/);
    assert.match(agents, /`packages\/ui\/`.*`packages\/ui\/package\.json`/);
    assert.match(agents, /npm run guardrails -- --base origin\/main/);
    assert.ok(fs.existsSync(path.join(m.dir, '.github/copilot-instructions.md')));
    const cfg = fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8');
    assert.match(cfg, /workspaces: \['apps\/\*', 'packages\/\*'\]/);
    assert.match(cfg, /name: 'apps', workspaces: \['apps\/web'\]/);
    // the generated docs are consistent with the repo
    const drift = m.run('check-doc-drift.ts');
    assert.equal(drift.status, 0, drift.output);
  });
});

test('workspaces as { packages: [...] } are discovered', () => {
  const m = makeMonorepo(BASE, { rootPackage: { name: 'r', private: true, type: 'module', workspaces: { packages: ['apps/*', 'packages/*'] } } });
  try {
    assert.match(m.run('check-imports.ts').output, /Passed/);
  } finally {
    m.cleanup();
  }
});

test('bootstrapping inside a workspace refuses and points to the root; --standalone overrides', () => {
  const m = mono({}, {}, undefined);
  try {
    const ws = path.join(m.dir, 'apps/web');
    const boot = (...a: string[]) => spawnSync(process.execPath, [path.join(SKILL_ROOT, 'scripts/bootstrap-repo.mjs'), '--target', ws, ...a], { encoding: 'utf8' });
    const r = boot();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /workspace "apps\/web"/);
    assert.ok(r.stderr.includes(m.dir));
    assert.ok(!fs.existsSync(path.join(ws, 'scripts')));
    assert.equal(boot('--standalone').status, 0);
    assert.ok(fs.existsSync(path.join(ws, 'scripts/check-doc-drift.ts')));
  } finally {
    m.cleanup();
  }
});

test('a root whose workspaces match nothing is refused without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-empty-'));
  fs.writeFileSync(path.join(dir, 'package.json'), pj({ name: 'r', workspaces: ['nothing/*'] }));
  const r = spawnSync(process.execPath, [path.join(SKILL_ROOT, 'scripts/bootstrap-repo.mjs'), '--target', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.deepEqual(fs.readdirSync(dir), ['package.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- check-imports ----------

test('check-imports: clean monorepo passes; a scan of 0 files fails', () => {
  mono({}, {}, (m) => assert.equal(m.run('check-imports.ts').status, 0));
  const empty = makeMonorepo({ 'apps/web/package.json': pj({ name: 'w' }), 'packages/ui/package.json': pj({ name: 'u' }) });
  try {
    const r = empty.run('check-imports.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /0 source files/i);
  } finally {
    empty.cleanup();
  }
});

test('check-imports: relative escapes, undeclared deps and deep imports are errors with file:line and fix', () => {
  mono(
    {
      'apps/web/src/a.ts': "export const x = 1;\nimport { b } from '../../../packages/ui/src/button.ts';\n",
      'apps/web/src/b.ts': "import { r } from '@m/other';\nimport('@m/ui/src/button.ts');\nexport { z } from '@m/ui/button';\n",
      'packages/other/package.json': pj({ name: '@m/other', exports: './src/i.ts' }),
      'packages/other/src/i.ts': 'export const r = 1;\n',
    },
    {},
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1);
      assert.match(r.output, /apps\/web\/src\/a\.ts:2 .*resolves outside its workspace/);
      assert.match(r.output, /apps\/web\/src\/b\.ts:1 .*"@m\/other".*does not declare it/);
      assert.match(r.output, /apps\/web\/src\/b\.ts:2 .*not a public entry/); // dynamic import
      assert.doesNotMatch(r.output, /b\.ts:3/); // allowed re-export
      assert.match(r.output, /fix:/);
    }
  );
});

test('check-imports: exports wildcard patterns, conditions and missing exports map', () => {
  mono(
    {
      'packages/ui/package.json': pj({ name: '@m/ui', exports: { '.': { types: './src/index.ts', default: './src/index.ts' }, './icons/*': './src/icons/*.ts' } }),
      'packages/legacy/package.json': pj({ name: '@m/legacy', main: 'src/index.ts' }),
      'packages/legacy/src/index.ts': 'export const l = 1;\n',
      'apps/web/package.json': pj({ name: '@m/web', dependencies: { '@m/ui': '*', '@m/legacy': '*' } }),
      'apps/web/src/c.ts': "import '@m/ui/icons/home';\nimport '@m/ui/icons/a/b';\nimport '@m/ui/button';\nimport '@m/legacy';\nimport '@m/legacy/src/index.ts';\n",
    },
    {},
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.output, /c\.ts:1 /);
      assert.match(r.output, /c\.ts:3 /); // ./button no longer exposed
      assert.doesNotMatch(r.output, /c\.ts:4 /);
      assert.match(r.output, /c\.ts:5 .*@m\/legacy/);
    }
  );
});

test('check-imports: .astro frontmatter and <script> imports are parsed; JSON scripts are ignored', () => {
  mono(
    {
      'apps/web/src/pages/p.astro':
        "---\nimport X from '../../../../packages/ui/src/button.ts';\n---\n<script type=\"application/ld+json\">import 'nope'</script>\n<script>\n  import '@m/ui/src/button.ts';\n</script>\n",
    },
    {},
    (m) => {
      const r = m.run('check-imports.ts');
      assert.match(r.output, /p\.astro:2 .*resolves outside/);
      assert.match(r.output, /p\.astro:6 .*not a public entry/);
      assert.doesNotMatch(r.output, /p\.astro:4/);
    }
  );
});

test('check-imports: layers (same layer, unlisted workspace, bad entries) and cycles', () => {
  const withLayers = (layers: string) => (cfg: string) => cfg.replace('  scopedModules: [],', `  layers: ${layers},\n  scopedModules: [],`);
  mono({}, { config: withLayers("[['packages/ui'], ['apps/web']]") }, (m) => assert.equal(m.run('check-imports.ts').status, 0));
  mono({}, { config: withLayers("[['packages/ui', 'apps/web']]") }, (m) => {
    const r = m.run('check-imports.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /same layer|strictly lower/i);
  });
  mono({}, { config: withLayers("[['apps/web'], ['packages/ui']]") }, (m) => assert.match(m.run('check-imports.ts').output, /layer/i));
  mono({ 'packages/extra/package.json': pj({ name: '@m/extra' }), 'packages/extra/src/i.ts': 'export {};\n' }, { config: withLayers("[['packages/ui'], ['apps/web']]") }, (m) => {
    const r = m.run('check-imports.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /packages\/extra.*layer/i);
  });
  mono({}, { config: withLayers("[{ name: 'low', workspaces: ['packages/*'] }, { name: 'high', workspaces: ['apps/*', 'nope/*'] }]") }, (m) => {
    assert.equal(m.run('check-imports.ts').status, 1); // stale entry
  });
  mono(
    {
      'packages/ui/package.json': pj({ name: '@m/ui', exports: './src/index.ts', dependencies: { '@m/web': '*' } }),
      'apps/web/package.json': pj({ name: '@m/web', exports: './src/index.ts', dependencies: { '@m/ui': '*' } }),
    },
    {},
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1);
      assert.match(r.output, /circular|cycle/i);
    }
  );
});

// ---------- check-ssr ----------

const astroWs = (cfg: string | null) => ({
  'apps/site/package.json': pj({ name: '@m/site', dependencies: { astro: '^5.0.0' } }),
  ...(cfg === null ? {} : { 'apps/site/astro.config.mjs': cfg }),
});

test('check-ssr: request data needs SSR; prerender flags and config output decide', () => {
  const page = (body: string) => ({ 'apps/site/src/pages/p.astro': `---\n${body}\n---\n<p/>\n` });
  const run = (cfg: string | null, body: string) => {
    const m = makeMonorepo({ ...BASE, ...astroWs(cfg), ...page(body) });
    try {
      return m.run('check-ssr.ts');
    } finally {
      m.cleanup();
    }
  };
  const staticCfg = "export default { output: 'static' };";
  const serverCfg = "export default defineConfig({ output: 'server' });";
  const read = "const v = Astro.cookies.get('a');";
  assert.equal(run(staticCfg, read).status, 1);
  assert.match(run(null, "const h = Astro.request.headers.get('x');").output, /p\.astro:2/);
  assert.equal(run(staticCfg, `export const prerender = false;\n${read}`).status, 0);
  assert.equal(run(serverCfg, read).status, 0);
  assert.equal(run(serverCfg, `export const prerender = true;\n${read}`).status, 1);
  assert.equal(run(staticCfg, "const { locals } = Astro;\nconst u = Astro.locals.user;").status, 1);
  assert.equal(run(staticCfg, "const q = Astro.url.searchParams.get('q');").status, 1);
  assert.equal(run(staticCfg, "const q = new URL(Astro.request.url).searchParams.get('q');").status, 1);
  assert.equal(run(staticCfg, "// Astro.cookies in a comment\nconst s = 'Astro.locals';").status, 0);
  assert.equal(run(staticCfg, 'const t = Astro.url.pathname;').status, 0);
});

// ---------- runner ----------

test('runner: reports every failure (no fail-fast), rejects unknown flags, requires tests in a monorepo', () => {
  mono(
    { 'apps/web/src/a.ts': "import '../../../packages/ui/src/button.ts';\n", 'packages/ui/README.md': 'See [gone](./missing.md)\n' },
    {},
    (m) => {
      const r = m.npm(['run', 'guardrails']);
      assert.equal(r.status, 1);
      assert.match(r.output, /npm run check:imports/);
      assert.match(r.output, /npm run check:drift/);
      assert.match(r.output, /guardrail failure\(s\)/);
      const bad = m.npm(['run', 'guardrails', '--', '--bogus']);
      assert.equal(bad.status, 1);
      assert.match(bad.output, /Unknown flag "--bogus"[\s\S]*Usage/);
      const pos = m.npm(['run', 'guardrails', '--', 'stray']);
      assert.equal(pos.status, 1);
      assert.match(pos.output, /Usage/);
    }
  );
  const noTests = { 'apps/web/package.json': pj({ name: '@m/web', dependencies: { '@m/ui': '*' } }) };
  mono(noTests, {}, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.equal(r.status, 1);
    assert.match(r.output, /requireTests: false/);
  });
  mono(noTests, { config: (c) => c.replace('requireTests: true', 'requireTests: false') }, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.doesNotMatch(r.output, /No `test` script/);
    assert.match(r.output, /Disabled or weakened checks[\s\S]*requireTests is false/);
    assert.equal(r.status, 1);
  });
});

test('runner: `npm run guardrails -- --base X` reaches the runner', () => {
  const m = mono({}, {}, undefined);
  try {
    spawnSync('git', ['init', '-q'], { cwd: m.dir });
    const r = m.npm(['run', 'guardrails', '--', '--base', 'does-not-exist']);
    assert.match(r.output, /run-guardrails\.ts --base does-not-exist/);
  } finally {
    m.cleanup();
  }
});

test('runner: build and test gates run from workspaces and fail the run', () => {
  mono({ 'apps/web/package.json': pj({ name: '@m/web', dependencies: { '@m/ui': '*' }, scripts: { build: 'exit 3', test: 'node --test' } }) }, {}, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.equal(r.status, 1);
    assert.match(r.output, /npm run build/);
  });
});

// ---------- doc drift ----------

test('doc-drift: dead routes, unknown npm scripts, placeholders, broken links and a missing ADR', () => {
  mono(
    {
      'apps/web/AGENTS.md': '# web\n',
      'AGENTS.md': [
        '# Router',
        '| Path | Context | ADR |',
        '| --- | --- | --- |',
        '| `packages/ui/` | `packages/ghost/README.md` | [adr](docs/adr/0001-workspace-boundaries.md) |',
        '| `apps/web/` | [ctx](apps/web/NOPE.md) | `apps/web/AGENTS.md` |',
        '',
        'Run `npm run does-not-exist` and `npm run guardrails -- --base x`.',
        'See ../package-lock.json and [lock](../package-lock.json) and TODO: fill in',
        '{{placeholder}} <TODO>',
      ].join('\n'),
      'apps/web/README.md': 'Run `npm run build` or `npm run nope` and `npm test -w @m/ui` and `npm run build -w nowhere`\n',
    },
    {},
    (m) => {
      const r = m.run('check-doc-drift.ts');
      assert.equal(r.status, 1);
      assert.match(r.output, /AGENTS\.md:4 routes to "packages\/ghost\/README\.md"/);
      assert.match(r.output, /AGENTS\.md:5 routes to "apps\/web\/NOPE\.md"/);
      assert.doesNotMatch(r.output, /routes to "docs\/adr/);
      assert.match(r.output, /AGENTS\.md:5 lists "apps\/web\/AGENTS\.md" as a governing ADR/);
      assert.match(r.output, /AGENTS\.md:7 quotes `npm run does-not-exist`/);
      assert.doesNotMatch(r.output, /quotes `npm run guardrails`/);
      assert.match(r.output, /AGENTS\.md:8 links to "\.\.\/package-lock\.json"/);
      assert.match(r.output, /Template Placeholder\] AGENTS\.md:8/);
      assert.match(r.output, /Template Placeholder\] AGENTS\.md:9/);
      assert.match(r.output, /apps\/web\/README\.md:1 quotes `npm run nope`/);
      assert.doesNotMatch(r.output, /README\.md:1 quotes `npm run build`/);
      assert.match(r.output, /Unknown Workspace\] apps\/web\/README\.md:1 .*"nowhere"/);
      assert.doesNotMatch(r.output, /quotes `npm test`/, 'a script that exists in any workspace is accepted');
    }
  );
});

test('doc-drift: a workspace-level AGENTS.md is checked against its own package.json', () => {
  mono({ 'apps/web/AGENTS.md': 'Use `npm run build` here and `npm run guardrails` from the root.\n`npm run missing-here`\n' }, {}, (m) => {
    const r = m.run('check-doc-drift.ts');
    assert.match(r.output, /apps\/web\/AGENTS\.md:2 quotes `npm run missing-here`/);
    assert.doesNotMatch(r.output, /AGENTS\.md:1 quotes/);
  });
});

test('doc-drift: ADR requirement is not satisfied by an AGENTS.md', () => {
  mono({}, {}, (m) => {
    fs.rmSync(path.join(m.dir, 'docs/adr'), { recursive: true });
    m.write('docs/adr/AGENTS.md', '# not a decision\n');
    const r = m.run('check-doc-drift.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /ADR Missing/);
  });
});

test('doc-drift: null visualSpecPath is reported as SKIPPED and interactive code without a spec fails', () => {
  mono({}, {}, (m) => {
    const ok = m.run('check-doc-drift.ts');
    assert.match(ok.output, /SKIPPED/);
    assert.doesNotMatch(ok.output, /selectors are in sync/);
    m.write('apps/web/src/C.astro', '<div>x</div>\n<script>\n  document.title = "x";\n</script>\n');
    m.write('apps/web/src/D.astro', '<Island client:load />\n');
    const bad = m.run('check-doc-drift.ts');
    assert.equal(bad.status, 1);
    assert.match(bad.output, /apps\/web\/src\/C\.astro:2 has interactive behaviour/);
    assert.match(bad.output, /D\.astro:1/);
  });
  mono({ 'apps/web/src/C.astro': '<script>1</script>\n' }, { config: (c) => c.replace('requireInteractiveSpecs: true', 'requireInteractiveSpecs: false') }, (m) => {
    const r = m.run('check-doc-drift.ts');
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /Advisory/);
  });
});

// ---------- deps ----------

test('check-deps: workspace-internal deps are never flagged or sent to the registry', () => {
  mono(
    {
      'apps/web/package.json': pj({ name: '@m/web', dependencies: { '@m/ui': '*', '@m/core': 'workspace:*', left: '*' } }),
      'packages/core/package.json': pj({ name: '@m/core', exports: './i.ts' }),
    },
    {},
    (m) => {
      const r = m.run('check-deps.ts');
      assert.equal(r.status, 1);
      assert.match(r.output, /"left": "\*"/);
      assert.doesNotMatch(r.output, /"@m\/ui"/);
      assert.doesNotMatch(r.output, /"@m\/core"/);
    }
  );
  mono({}, {}, (m) => assert.equal(m.run('check-deps.ts').status, 0));
});

test('check-deps --audit: a hung registry call times out with one clean line', () => {
  mono({}, { config: (c) => c.replace('auditTimeoutMs: 30000', 'auditTimeoutMs: 300') }, (m) => {
    const bin = path.join(m.dir, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const r = m.run('check-deps.ts', ['--audit'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1);
    assert.match(r.output, /timed out after \d+s/);
    assert.doesNotMatch(r.output, /\{"summary"/);
  });
});

test('check-deps --audit: an error JSON without details becomes readable text', () => {
  mono({}, {}, (m) => {
    const bin = path.join(m.dir, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho \'{"error":{"summary":"","detail":""}}\'\nexit 1\n', { mode: 0o755 });
    const r = m.run('check-deps.ts', ['--audit'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1);
    assert.match(r.output, /without details/);
    assert.doesNotMatch(r.output, /\{"summary"/);
  });
});

// ---------- TypeScript guard ----------

test('an unsupported typescript (7.x) fails with one actionable message, never "reading Latest"', () => {
  mono({}, {}, (m) => {
    const tsDir = path.join(m.dir, 'node_modules/typescript');
    fs.rmSync(tsDir, { force: true, recursive: true });
    fs.mkdirSync(tsDir);
    fs.writeFileSync(path.join(tsDir, 'package.json'), pj({ name: 'typescript', version: '7.0.0-beta', main: 'index.js' }));
    fs.writeFileSync(path.join(tsDir, 'index.js'), 'module.exports = {};\n');
    for (const script of ['check-imports.ts', 'check-complexity.ts', 'check-doc-drift.ts', 'check-ssr.ts']) {
      const r = m.run(script);
      assert.equal(r.status, 1, script);
      assert.match(r.output, /typescript@~5\.9/, script);
      assert.doesNotMatch(r.output, /reading 'Latest'/, script);
    }
  });
});

// ---------- clone detection ----------

const CLONE = (name: string, v: string) => `export function ${name}(items: string[], limit: number) {
  const out: string[] = [];
  let count = 0;
  for (const ${v} of items) {
    if (${v}.length > limit) continue;
    out.push(${v}.trim().toLowerCase());
    count += 1;
  }
  const label = 'total:' + count;
  console.log(label);
  return out;
}
`;

test('check-complexity: a duplicated function across two workspaces is reported (and fails when configured)', () => {
  const files = { 'apps/web/src/a.ts': CLONE('alpha', 'it'), 'packages/ui/src/b.ts': CLONE('beta', 'entry').replace("'total:'", "'sum='") };
  mono(files, {}, (m) => {
    const r = m.run('check-complexity.ts');
    assert.equal(r.status, 0);
    assert.match(r.output, /Cross-File Function Clone\] apps\/web\/src\/a\.ts:1/);
    assert.match(r.output, /packages\/ui\/src\/b\.ts:1/);
  });
  mono(files, { config: (c) => c.replace('failOnComplexityAdvisories: false', 'failOnComplexityAdvisories: true') }, (m) => {
    assert.equal(m.run('check-complexity.ts').status, 1);
  });
  mono({ 'apps/web/src/a.ts': CLONE('alpha', 'it'), 'packages/ui/src/b.ts': 'export function other(a: number) {\n  return a + 1;\n}\n' }, {}, (m) => {
    assert.doesNotMatch(m.run('check-complexity.ts').output, /Function Clone/);
  });
});

// ---------- check-arch ----------

test('check:arch fails when dependency-cruiser is missing, cruises nothing, or reports a transpiler problem', () => {
  mono({}, {}, (m) => {
    assert.match(m.run('check-arch.ts').output, /not installed/);
    const bin = path.join(m.dir, 'node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    const stub = (body: string) => fs.writeFileSync(path.join(bin, 'depcruise'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('echo \'{"summary":{"totalCruised":0,"violations":[]}}\'');
    const zero = m.run('check-arch.ts');
    assert.equal(zero.status, 1);
    assert.match(zero.output, /cruised 0 modules/);
    stub('echo "Error: The typescript transpiler is not available" >&2\necho \'{"summary":{"totalCruised":4,"violations":[]}}\'');
    const transpiler = m.run('check-arch.ts');
    assert.equal(transpiler.status, 1);
    assert.match(transpiler.output, /transpiler/);
    stub('echo \'{"summary":{"totalCruised":4,"violations":[]}}\'');
    assert.equal(m.run('check-arch.ts').status, 0);
  });
});

// ---------- follow-up: astro-only workspaces, deps dedupe, selector coverage ----------

test('check:arch skips .astro-only workspaces but still fails on cruisable sources with 0 modules', () => {
  mono({ 'packages/ui/src/Card.astro': '<div />\n' }, {}, (m) => {
    fs.rmSync(path.join(m.dir, 'packages/ui/src/index.ts'));
    fs.rmSync(path.join(m.dir, 'packages/ui/src/button.ts'));
    fs.rmSync(path.join(m.dir, 'apps/web/src/index.ts'));
    const bin = path.join(m.dir, 'node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    const stub = (body: string) => fs.writeFileSync(path.join(bin, 'depcruise'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('echo \'{"summary":{"totalCruised":0,"violations":[]}}\'');
    m.write('apps/web/src/x.astro', '<p/>\n');
    const ok = m.run('check-arch.ts');
    assert.equal(ok.status, 0, ok.output);
    assert.match(ok.output, /\d+ \.astro file\(s\) not cruised \(covered by check:imports\)/);
    m.write('apps/web/src/real.ts', 'export const x = 1;\n');
    const bad = m.run('check-arch.ts');
    assert.equal(bad.status, 1);
    assert.match(bad.output, /apps\/web: dependency-cruiser cruised 0 modules/);
  });
});

test('check:imports reports a deep import from a pure-.astro package', () => {
  mono({
    'apps/web/src/C.astro': "---\nimport s from '@m/ui/src/button.ts';\n---\n<p>{s}</p>\n",
  }, {}, (m) => {
    fs.rmSync(path.join(m.dir, 'apps/web/src/index.ts'));
    const r = m.run('check-imports.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /apps\/web\/src\/C\.astro:2/);
  });
});

test('check-deps collapses identical findings across workspaces and prefixes the declaring workspaces', () => {
  const dep = (name: string) => pj({ name, version: '1.0.0', dependencies: { 'left-pad': '*' } });
  mono({ 'apps/web/package.json': dep('@m/web'), 'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts' }, dependencies: { 'left-pad': '*' } }) }, {}, (m) => {
    const r = m.run('check-deps.ts');
    assert.equal(r.status, 1, r.output);
    const lines = r.output.split('\n').filter((l) => l.includes('Unpinned Dependency Version'));
    assert.equal(lines.length, 1, r.output);
    assert.match(lines[0], /\[apps\/web, packages\/ui\] \[Unpinned Dependency Version\] "left-pad"/);
  });
});

test('doc-drift selector coverage uses every workspace src folder once visualSpecPath is set', () => {
  const cfg = (c: string) => c.replace('visualSpecPath: null', "visualSpecPath: 'tests/ui.spec.ts'");
  const comp = '<button data-testid="faq-toggle">x</button>\n';
  mono({ 'packages/ui/src/FaqAccordion.astro': comp, 'tests/ui.spec.ts': "page.getByTestId('other');\n" }, { config: cfg }, (m) => {
    const bad = m.run('check-doc-drift.ts');
    assert.equal(bad.status, 1, bad.output);
    assert.equal((bad.output.match(/Untested Interactive UI/g) ?? []).length, 1, bad.output);
    assert.match(bad.output, /packages\/ui\/src\/FaqAccordion\.astro/);
    m.write('tests/ui.spec.ts', "page.getByTestId('faq-toggle');\n");
    const ok = m.run('check-doc-drift.ts');
    assert.doesNotMatch(ok.output, /Untested Interactive UI/);
  });
});
