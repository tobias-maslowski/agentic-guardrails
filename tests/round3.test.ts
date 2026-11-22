import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeMonorepo, type Monorepo } from './helpers.ts';

const pj = (o: object) => JSON.stringify(o, null, 2);
const BASE: Record<string, string> = {
  'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*', astro: '^5.0.0' }, scripts: { build: 'node -e 0', test: 'node --test' } }),
  'apps/web/astro.config.mjs': "export default { output: 'static' };\n",
  'apps/web/src/pages/index.astro': '---\nimport Card from "../components/Card.astro";\n---\n<Card />\n',
  'apps/web/src/components/Card.astro': '---\nconst a = 1;\n---\n<p>{a}</p>\n',
  'packages/domain/package.json': pj({ name: '@m/domain', version: '1.0.0', exports: { '.': './src/index.ts' } }),
  'packages/domain/src/index.ts': 'export const d = 1;\n',
  'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', dependencies: { '@m/domain': '*' }, exports: { '.': './src/index.ts' } }),
  'packages/ui/src/index.ts': "import { d } from '@m/domain';\nexport const button = d;\n",
};

function mono(extra: Record<string, string>, fn: (m: Monorepo) => void, opts: Parameters<typeof makeMonorepo>[1] = {}) {
  const m = makeMonorepo({ ...BASE, ...extra }, opts);
  try {
    fn(m);
  } finally {
    m.cleanup();
  }
}

test('check:ssr: prerendered .ts endpoints and transitive reads in child components are reported with both locations', () => {
  mono(
    {
      'apps/web/src/pages/api/me.ts': "export const prerender = true;\nexport const GET = ({ cookies }) => new Response(cookies.get('s')?.value ?? '');\n",
      'apps/web/src/pages/account.astro': '---\nimport Who from "../components/Who.astro";\n---\n<Who />\n',
      'apps/web/src/components/Who.astro': '---\nconst s = Astro.cookies.get("s");\n---\n<p>{s?.value}</p>\n',
    },
    (m) => {
      const r = m.run('check-ssr.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /api\/me\.ts:2/);
      assert.match(r.output, /account\.astro:2[\s\S]*Who\.astro:2/);
    }
  );
  mono({ 'apps/web/src/pages/api/me.ts': "export const prerender = false;\nexport const GET = ({ cookies }) => new Response(cookies.get('s')?.value ?? '');\n" }, (m) => {
    const r = m.run('check-ssr.ts');
    assert.equal(r.status, 0, r.output);
  });
});

test('check:imports: node:fs in a pure workspace, undeclared externals and externalRules allowOnly', () => {
  mono({ 'packages/domain/src/io.ts': "import fs from 'node:fs';\nexport const r = fs;\n", 'packages/ui/src/cms.ts': "import { x } from '@storyblok/js';\nexport const y = x;\n" }, (m) => {
    const r = m.run('check-imports.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /packages\/domain\/src\/io\.ts:1[\s\S]*node:fs/);
    assert.match(r.output, /packages\/ui\/src\/cms\.ts:1[\s\S]*@storyblok\/js/);
  });
  mono({ 'packages/ui/src/ok.ts': "import { d } from '@m/domain';\nimport 'node:path';\nexport const z = d;\n" }, (m) => {
    assert.equal(m.run('check-imports.ts').status, 0, m.run('check-imports.ts').output);
  });
  mono(
    { 'packages/ui/src/a.ts': "import 'left-pad';\nimport 'lodash';\n", 'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', dependencies: { '@m/domain': '*', 'left-pad': '1.0.0', lodash: '4.0.0' }, exports: { '.': './src/index.ts' } }) },
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /lodash/);
      assert.doesNotMatch(r.output, /"left-pad"/);
    },
    { config: (c) => c.replace('externalRules: [', "externalRules: [\n    { workspaces: ['@m/ui'], allowOnly: ['left-pad', '@m/*'] },") }
  );
});

test('check:caching: cookie/session readers without no-store|private are errors; clean variants are green', () => {
  mono(
    {
      'apps/web/src/pages/api/me.ts': "export const prerender = false;\nexport const GET = ({ cookies }) => {\n  const id = cookies.get('member')?.value;\n  return new Response(id);\n};\n",
      'apps/web/src/components/Who.astro': "---\nconst s = Astro.cookies.get('session');\n---\n<p>{s?.value}</p>\n",
      'apps/web/src/pages/who.astro': '---\nexport const prerender = false;\nimport Who from "../components/Who.astro";\n---\n<Who />\n',
    },
    (m) => {
      const r = m.run('check-caching.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /me\.ts:3[\s\S]*Cache-Control/);
      assert.match(r.output, /who\.astro:\d+[\s\S]*Who\.astro:2/);
    }
  );
  // page-level header, layout-in-chain header, middleware header and an opt-out comment each satisfy the rule
  mono(
    {
      'apps/web/src/pages/api/a.ts': "export const GET = ({ cookies }) => new Response(cookies.get('s')?.value, { headers: { 'Cache-Control': 'private, no-store' } });\n",
      'apps/web/src/layouts/L.astro': "---\nAstro.response.headers.set('Cache-Control', 'private');\n---\n<slot />\n",
      'apps/web/src/pages/b.astro': '---\nimport L from "../layouts/L.astro";\nconst c = Astro.cookies.get("s");\n---\n<L>{c?.value}</L>\n',
      'apps/web/src/pages/api/c.ts': "// guardrails-allow: caching response is identical for all members\nexport const GET = ({ cookies }) => new Response(String(cookies.has('s')));\n",
      'apps/web/src/pages/api/not-personal.ts': "export const GET = ({ url }) => new Response(url.searchParams.get('q'));\n",
    },
    (m) => {
      const r = m.run('check-caching.ts');
      assert.equal(r.status, 0, r.output);
    }
  );
  mono(
    {
      'apps/web/src/middleware.ts': "export const onRequest = async (c, next) => {\n  const res = await next();\n  res.headers.set('Cache-Control', 'private, no-store');\n  return res;\n};\n",
      'apps/web/src/pages/api/a.ts': "export const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n",
    },
    (m) => assert.equal(m.run('check-caching.ts').status, 0)
  );
  // a comment, an unrelated branch and a wrapper in the worker entry
  mono(
    { 'apps/web/src/pages/api/a.ts': "// Cache-Control: private, no-store (TODO)\nexport const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n" },
    (m) => assert.equal(m.run('check-caching.ts').status, 1)
  );
  mono(
    { 'apps/web/src/pages/api/a.ts': "export const GET = ({ cookies, url }) => {\n  const h = new Headers();\n  if (url.pathname === '/x') h.set('Cache-Control', 'no-store');\n  return new Response(cookies.get('s')?.value, { headers: h });\n};\n" },
    (m) => assert.equal(m.run('check-caching.ts').status, 1, 'conditional set in an unrelated branch must not count')
  );
  mono(
    {
      'apps/web/src/worker.ts': "export default {\n  async fetch(req, env) {\n    const res = await env.ASSETS.fetch(req);\n    const out = new Response(res.body, res);\n    out.headers.set('Cache-Control', 'private, no-store');\n    return out;\n  },\n};\n",
      'apps/web/src/pages/api/a.ts': "export const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n",
    },
    (m) => assert.equal(m.run('check-caching.ts').status, 0, m.run('check-caching.ts').output)
  );
  // an opt-out without a reason is itself an error
  mono(
    { 'apps/web/src/pages/api/a.ts': "// guardrails-allow: caching\nexport const GET = ({ cookies }) => new Response(cookies.get('s')?.value);\n" },
    (m) => {
      const r = m.run('check-caching.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /no reason/);
    }
  );
});

test('check:imports: test files are exempt from externalRules and undeclared-package checks, production code is not', () => {
  mono(
    {
      'packages/domain/src/io.ts': "import fs from 'node:fs';\nexport const f = fs;\n",
      'packages/domain/src/io.test.ts': "import test from 'node:test';\nimport fs from 'node:fs';\nimport { helper } from 'some-test-only-pkg';\ntest('x', () => fs && helper);\n",
      'packages/domain/tests/more.ts': "import 'node:fs';\nimport 'another-undeclared';\n",
    },
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /packages\/domain\/src\/io\.ts:1/);
      assert.doesNotMatch(r.output, /io\.test\.ts|tests\/more\.ts/);
    }
  );
});

test('doc drift: cookie attributes and HTTP fragments in backticks are not file paths', () => {
  mono(
    {
      'README.md': '# Repo\n\nThe cookie uses `Path=/` and `Max-Age=3600; Path=/members/`, the header `Set-Cookie: a=b; Path=/`, and `/api/thing`.\nBut `packages/ui/src/gone.ts` is gone.\n',
    },
    (m) => {
      const r = m.run('check-doc-drift.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /gone\.ts/);
      assert.doesNotMatch(r.output, /Path=/);
      assert.doesNotMatch(r.output, /\/api\/thing/);
    }
  );
});

test('doc drift: dead paths in any markdown and invented routes are errors; allow list and fences are skipped', () => {
  mono(
    {
      'apps/web/src/pages/members/index.astro': '<p>m</p>\n',
      'apps/web/src/pages/api/ping.ts': 'export const GET = () => new Response("ok");\n',
      'apps/web/src/pages/blog/[slug].astro': '<p>b</p>\n',
      'README.md': '# Repo\n\nSee `packages/ui/src/missing.ts` and `packages/ui/src/index.ts`.\n\n```\n`packages/ui/src/fenced.ts`\n```\n\n## Routes\n\n| Route | Notes |\n| --- | --- |\n| `/members` | ok |\n| `/api/ping` | ok |\n| `/blog/hello` | ok |\n| `/invented` | nope |\n',
      'docs/guide.md': 'Key files: `packages/ui/src/gone.ts`, `generated/out.js`.\n',
    },
    (m) => {
      const r = m.run('check-doc-drift.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /README\.md:3[\s\S]*missing\.ts/);
      assert.doesNotMatch(r.output, /fenced\.ts/);
      assert.match(r.output, /README\.md:\d+ documents route "\/invented"/);
      assert.doesNotMatch(r.output, /route "\/(members|api\/ping|blog\/hello)"/);
      assert.match(r.output, /docs\/guide\.md:1[\s\S]*gone\.ts/);
    },
    { config: (c) => c.replace('requireTests: true,', "requireTests: true,\n  docClaimsAllow: ['generated/*'],") }
  );
});

test('runner: weakened config fails unless accepted with a reason; strict bootstrap defaults are clean', () => {
  mono({}, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.doesNotMatch(r.output, /Disabled or weakened checks/, r.output);
  });
  const weak = (extra: string) => (c: string) => c.replace('requireTests: true,', `requireTests: true,\n  ${extra}`);
  mono({}, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.equal(r.status, 1);
    assert.match(r.output, /Disabled or weakened checks[\s\S]*externalRules is empty/);
  }, { config: weak('externalRules: [],') });
  mono({}, (m) => {
    const r = m.npm(['run', 'guardrails']);
    assert.match(r.output, /Accepted: allowWeakenedConfig is true\. Reason: legacy app/);
    assert.doesNotMatch(r.output, /weakened config/);
  }, { config: weak("externalRules: [], allowWeakenedConfig: true, weakenedConfigReason: 'legacy app',") });
  mono({}, (m) => {
    assert.equal(m.npm(['run', 'guardrails']).status, 1);
  }, { config: weak('externalRules: [], allowWeakenedConfig: true,') });
});

test('runner: clean-tree visual gate says it was skipped', () => {
  mono({ 'tests/ui.spec.ts': "page.getByTestId('x');\n", '.gitignore': 'node_modules\n' }, (m) => {
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: m.dir });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const r = m.npm(['run', 'guardrails']);
    assert.match(r.output, /skipped \(no changed files match triggers\); use --all or CI/);
  }, { config: (c) => c.replace('visualSpecPath: null', "visualSpecPath: 'tests/ui.spec.ts'") });
});

test('bootstrap: root check:types runs astro check for .astro workspaces when @astrojs/check is declared, else advises', () => {
  const tsconfig = '{ "compilerOptions": {} }\n';
  mono({ 'apps/web/tsconfig.json': tsconfig, 'packages/ui/tsconfig.json': tsconfig, 'packages/ui/src/X.astro': '<p/>\n' }, (m) => {
    const root = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8'));
    assert.equal(root.scripts['check:types'], undefined);
  });
  mono(
    { 'apps/web/tsconfig.json': tsconfig, 'packages/ui/tsconfig.json': tsconfig, 'packages/domain/tsconfig.json': tsconfig, 'packages/ui/src/X.astro': '<p/>\n', 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, devDependencies: { '@astrojs/check': '^0.9.0' }, scripts: { build: 'x', test: 'x' } }) },
    (m) => {
      const root = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8'));
      assert.match(root.scripts['check:types'], /astro check --root packages\/ui/);
      assert.match(root.scripts['check:types'], /astro check --root apps\/web/);
      assert.match(root.scripts['check:types'], /tsc --noEmit -p packages\/domain/);
    }
  );
});

test('check-deps (monorepo): outdated is evaluated per package via the registry, local packages are skipped, TypeScript major is informational', () => {
  const fakeBin = (m: Monorepo, latest: string) => {
    const bin = path.join(m.dir, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = view ]; then echo '"${latest}"'; exit 0; fi\nif [ "$1" = audit ]; then echo '{"vulnerabilities":{}}'; exit 0; fi\nexit 0\n`, { mode: 0o755 });
    return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  };
  const files = { 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*', foo: '^1.0.0' }, scripts: { build: 'x', test: 'x' } }), 'node_modules/foo/package.json': pj({ name: 'foo', version: '1.0.0' }) };
  mono(files, (m) => {
    const r = m.run('check-deps.ts', ['--audit'], fakeBin(m, '2.0.0'));
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /Outdated Direct Dependency\] "foo" is at 1\.0\.0 \(latest stable: 2\.0\.0, major behind\)/);
    assert.doesNotMatch(r.output, /"@m\//);
  });
  mono({ ...files, 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, devDependencies: { typescript: '~5.9.0' }, scripts: { build: 'x', test: 'x' } }) }, (m) => {
    const r = m.run('check-deps.ts', ['--audit'], fakeBin(m, '7.0.0'));
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /latest major not yet supported by the guardrail checks, pinned to supported range/);
  });
});

test('dependency-cruiser config: rules only for existing folders and matched at any depth', () => {
  mono({ 'packages/domain/src/domain/x.ts': 'export const x = 1;\n' }, (m) => {
    const out = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.join(m.dir, '.dependency-cruiser.cjs'))});`+ "console.log(JSON.stringify(c.forbidden.map(r=>[r.name,r.from.path||''])))"], { cwd: path.join(m.dir, 'packages/domain'), encoding: 'utf8' });
    const rules = JSON.parse(out.stdout) as Array<[string, string]>;
    const names = rules.map((r) => r[0]);
    assert.ok(names.includes('domain-must-be-pure'), out.stdout + out.stderr);
    assert.ok(names.includes('no-circular-dependencies'));
    assert.ok(!names.includes('ui-must-be-cms-and-worker-agnostic'));
    assert.ok(rules.filter((r) => r[0] !== 'no-circular-dependencies').every((r) => r[1].startsWith('(^|/)src/')), out.stdout);
    assert.ok(new RegExp(rules.find((r) => r[0] === 'domain-must-be-pure')![1]).test('packages/domain/src/domain/x.ts'));
  });
});

// Appended last so it overrides a same-named key of the generated config.
const weakCfg = (extra: string) => (c: string) => c.replace(/\n};\s*$/, `\n  ${extra}\n};\n`);
const weakCases: Array<[string, string, RegExp]> = [
  ['narrowed requiredGates', "requiredGates: ['check:arch'],", /requiredGates is narrowed[\s\S]*check:imports/],
  ['narrowed optionalGates', "optionalGates: ['build'],", /optionalGates is narrowed/],
  ['importScanIgnoreDirs src', "importScanIgnoreDirs: ['src'],", /importScanIgnoreDirs contains "src"/],
  ['importScanIgnoreDirs workspace dir', "importScanIgnoreDirs: ['apps/web'],", /importScanIgnoreDirs contains "apps\/web"/],
  ['docClaimsAllow catch-all', "docClaimsAllow: ['**'],", /docClaimsAllow contains the catch-all/],
  ['raised thresholds', 'thresholds: { functionCognitive: 40, functionCyclomatic: 12, astroScriptMaxStatements: 25, astroScriptMaxCognitive: 12 },', /thresholds\.functionCognitive is 40/],
  ['broad testGlobs', "testGlobs: ['**/*.ts'],", /testGlobs contains "\*\*\/\*\.ts"/],
];
for (const [name, extra, re] of weakCases) {
  test(`weakened config detects: ${name}`, () => {
    mono({}, (m) => {
      const r = m.npm(['run', 'guardrails']);
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, re);
    }, { config: weakCfg(extra) });
  });
}

test('weakened config: no-op or runner-less test scripts fail; real runners pass', () => {
  for (const cmd of ['true', 'exit 0', 'echo ok', ':']) {
    mono({ 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, scripts: { test: cmd } }) }, (m) => {
      const r = m.npm(['run', 'guardrails']);
      assert.equal(r.status, 1, `${cmd}\n${r.output}`);
      assert.match(r.output, /"test" script is a no-op/);
    });
  }
  mono({ 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, scripts: { test: 'my-tool run' } }) }, (m) => {
    assert.match(m.npm(['run', 'guardrails']).output, /no known test runner/);
  });
  mono({}, (m) => assert.doesNotMatch(m.npm(['run', 'guardrails']).output, /test" script/));
});

const GATE = "export const onRequest = (c, next) => { if (c.url.searchParams.get('key') !== c.locals.secret) return new Response(null, { status: 404 }); return next(); };\n";
test('check:gate: site-wide 404 gate with static assets needs run_worker_first', () => {
  mono({ 'apps/web/src/middleware.ts': GATE, 'apps/web/wrangler.jsonc': '{ // c\n "name": "w", "assets": { "directory": "./dist" } }\n' }, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /wrangler\.jsonc:1[\s\S]*run_worker_first/);
    m.write('apps/web/wrangler.jsonc', '{ "name": "w", "assets": { "directory": "./dist", "run_worker_first": true } }\n');
    assert.equal(m.run('check-gate.ts').status, 0);
    m.write('apps/web/wrangler.toml', '');
    fs.rmSync(path.join(m.dir, 'apps/web/wrangler.jsonc'));
    m.write('apps/web/wrangler.toml', 'name = "w"\n[assets]\ndirectory = "./dist"\n');
    assert.equal(m.run('check-gate.ts').status, 1);
    m.write('apps/web/wrangler.toml', 'name = "w"\n[assets]\ndirectory = "./dist"\nrun_worker_first = true\n');
    assert.equal(m.run('check-gate.ts').status, 0);
    m.write('apps/web/wrangler.toml', 'name = "w"\nmain = "src/entry.ts"\n[assets]\ndirectory = "./dist"\n');
    m.write('apps/web/src/entry.ts', 'export default { fetch: (r, env) => env.ASSETS.fetch(r) };\n');
    assert.equal(m.run('check-gate.ts').status, 0);
  });
  mono({ 'apps/web/wrangler.jsonc': '{ "assets": {} }\n' }, (m) => {
    const r = m.run('check-gate.ts');
    assert.equal(r.status, 0);
    assert.match(r.output, /no site-wide access gate detected/);
  });
});

test('bootstrap: CI workflow generated once, skipped when a workflow already runs guardrails; --hooks is opt-in', () => {
  mono({}, (m) => {
    const wf = fs.readFileSync(path.join(m.dir, '.github/workflows/guardrails.yml'), 'utf8');
    assert.match(wf, /npm ci/);
    assert.match(wf, /npm run guardrails -- --all/);
    assert.equal(fs.existsSync(path.join(m.dir, '.githooks/pre-push')), false);
  });
  mono({ '.github/workflows/ci.yml': 'jobs:\n  x:\n    steps:\n      - run: npm run guardrails -- --all\n' }, (m) => {
    assert.equal(fs.existsSync(path.join(m.dir, '.github/workflows/guardrails.yml')), false);
  });
  mono({}, (m) => {
    const hook = path.join(m.dir, '.githooks/pre-push');
    assert.match(fs.readFileSync(hook, 'utf8'), /npm run guardrails/);
    assert.ok(fs.statSync(hook).mode & 0o100);
  }, { bootstrapArgs: ['--hooks'] });
});

test('doc-drift: bare filenames after their directory are not root-relative claims; real dir paths still are', () => {
  mono({
    'README.md': '# R\n\nThe page lives in `apps/web/src/pages/` and its entry is `index.astro`; also `FaqAccordion.astro`.\n',
  }, (m) => {
    const ok = m.run('check-doc-drift.ts');
    assert.doesNotMatch(ok.output, /index\.astro|FaqAccordion/, ok.output);
    m.write('README.md', '# R\n\nSee `apps/web/src/pages/missing.astro`.\n');
    assert.match(m.run('check-doc-drift.ts').output, /missing\.astro/);
  });
});

test('bootstrap: default externalRules only for pure-named packages and never forbid @storyblok or astro for ui', () => {
  mono({ 'packages/utils/package.json': pj({ name: '@m/utils', version: '1.0.0', exports: { '.': './src/index.ts' } }), 'packages/utils/src/index.ts': 'export const u = 1;\n' }, (m) => {
    const cfg = fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8');
    const rule = cfg.match(/externalRules: \[([\s\S]*?)\n  \],/)?.[1] ?? '';
    assert.match(rule, /packages\/domain/);
    assert.match(rule, /packages\/utils/);
    assert.doesNotMatch(rule, /packages\/ui|apps\/web|@storyblok|layer/);
    assert.match(rule, /forbid: \['node:\*', 'cloudflare:\*', 'astro:\*'\]/);
    assert.match(cfg, /\/\/ .*@storyblok/);
  });
});

test('bootstrap: interactive .astro files get a next-step message, and a spec skeleton only when Playwright is declared', () => {
  const files = { 'apps/web/src/components/Tog.astro': '<button id="t">x</button>\n<script>document.getElementById("t")</script>\n' };
  const boot = (extraFiles: Record<string, string>, bootstrapArgs: string[] = []) => {
    const m = makeMonorepo({ ...BASE, ...files, ...extraFiles }, { bootstrapArgs });
    return m;
  };
  let m = boot({});
  try {
    assert.equal(fs.existsSync(path.join(m.dir, 'tests/interactive.spec.ts')), false);
    assert.match(m.npm(['run', 'guardrails']).output, /visualSpecPath is null/);
  } finally { m.cleanup(); }
  m = boot({ 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, devDependencies: { '@playwright/test': '^1.40.0' }, scripts: { test: 'node --test' } }) });
  try {
    assert.equal(fs.existsSync(path.join(m.dir, 'tests/interactive.spec.ts')), false, 'no stub file by default');
  } finally { m.cleanup(); }
  m = boot({ 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, devDependencies: { '@playwright/test': '^1.40.0' }, scripts: { test: 'node --test' } }) }, ['--scaffold-specs']);
  try {
    assert.match(fs.readFileSync(path.join(m.dir, 'tests/interactive.spec.ts'), 'utf8'), /test\.fixme\('apps\/web\/src\/components\/Tog\.astro/);
    assert.match(fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8'), /visualSpecPath: 'tests\/interactive\.spec\.ts'/);
  } finally { m.cleanup(); }
});

test('check:drift selector forms: testid, id, class, role, aria-label are each accepted; uncovered controls fail', () => {
  const comp = (attrs: string) => ({ 'apps/web/src/components/T.astro': `<button ${attrs}>x</button>\n` });
  const cases: Array<[string, string, boolean]> = [
    ['data-testid="tog"', "page.getByTestId('tog');", true],
    ['data-testid="tog"', "page.locator('[data-testid=tog]');", true],
    ['id="tog-id"', "page.locator('#tog-id');", true],
    ['class="btn primary"', "page.locator('button.primary');", true],
    ['role="switch"', "page.getByRole('switch');", true],
    ['aria-label="Open menu"', "page.getByRole('button', { name: 'Open menu' });", true],
    ['class="btn primary"', "page.locator('.other');", false],
  ];
  for (const [attrs, spec, ok] of cases) {
    mono({ ...comp(attrs), 'tests/ui.spec.ts': `${spec}\n` }, (m) => {
      const r = m.run('check-doc-drift.ts');
      assert.equal(r.status, ok ? 0 : 1, `${attrs} / ${spec}\n${r.output}`);
    }, { config: (c) => c.replace('visualSpecPath: null', "visualSpecPath: 'tests/ui.spec.ts'") });
  }
});

test('src/pages markdown: AGENTS.md is an accidental route, _AGENTS.md is accepted as the scoped file', () => {
  mono({ 'apps/web/src/pages/AGENTS.md': '# a\n' }, (m) => {
    const r = m.run('check-doc-drift.ts');
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /Accidental Route[\s\S]*apps\/web\/src\/pages\/AGENTS\.md:1[\s\S]*"\/AGENTS"/);
    fs.rmSync(path.join(m.dir, 'apps/web/src/pages/AGENTS.md'));
    m.write('apps/web/src/pages/_AGENTS.md', '# a\n\n## Exported Modules\n- `index.astro`\n');
    const ok = m.run('check-doc-drift.ts');
    assert.doesNotMatch(ok.output, /Accidental Route|Missing Scoped Context/, ok.output);
  }, { config: (c) => c.replace('scopedModules: [],', "scopedModules: ['src/pages'],") });
});

test('bootstrap check:types: astro check per Astro app only with @astrojs/check (any workspace); otherwise the install command and no script', () => {
  const ws = (extra: object) => pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*', astro: '^5.0.0' }, scripts: { test: 'node --test' }, ...extra });
  const tsconfig = '{ "compilerOptions": { "strict": true } }\n';
  mono({ 'apps/web/tsconfig.json': tsconfig, 'packages/domain/tsconfig.json': tsconfig, 'apps/web/package.json': ws({ devDependencies: { '@astrojs/check': '^0.9.0' } }) }, (m) => {
    const scripts = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['check:types'], /astro check --root apps\/web/);
    assert.match(scripts['check:types'], /tsc --noEmit -p packages\/domain/);
    assert.doesNotMatch(scripts['check:types'], /tsc --noEmit -p apps\/web/);
  });
  mono({ 'apps/web/tsconfig.json': tsconfig, 'apps/web/package.json': ws({}) }, (m) => {
    const scripts = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts['check:types'], undefined);
  });
});

test('bootstrap: CI installs chromium only when Playwright is declared; generated files pass git diff --check', () => {
  const pw = { 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', '@m/domain': '*' }, devDependencies: { '@playwright/test': '^1.40.0' }, scripts: { test: 'node --test' } }) };
  mono(pw, (m) => assert.match(fs.readFileSync(path.join(m.dir, '.github/workflows/guardrails.yml'), 'utf8'), /npx playwright install --with-deps chromium/));
  mono({}, (m) => {
    assert.doesNotMatch(fs.readFileSync(path.join(m.dir, '.github/workflows/guardrails.yml'), 'utf8'), /playwright/);
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...a], { cwd: m.dir, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(m.dir, '.gitignore'), 'node_modules\n');
    git('add', '-A');
    const r = git('diff', '--cached', '--check');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }, { bootstrapArgs: ['--hooks'] });
});
