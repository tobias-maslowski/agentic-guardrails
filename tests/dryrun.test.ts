import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeMonorepo, type Monorepo } from './helpers.ts';

const pj = (o: object) => JSON.stringify(o, null, 2);
const BASE: Record<string, string> = {
  'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*' }, scripts: { build: 'node -e 0', test: 'node --test' } }),
  'apps/web/astro.config.mjs': "export default { output: 'static' };\n",
  'apps/web/src/pages/index.astro': '---\nconst a = 1;\n---\n<p>{a}</p>\n',
  'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts' } }),
  'packages/ui/src/index.ts': 'export const button = 1;\n',
};
const append = (extra: string) => (c: string) => c.replace(/\n};\s*$/, `\n  ${extra}\n};\n`);

function mono(extra: Record<string, string>, fn: (m: Monorepo) => void, opts: Parameters<typeof makeMonorepo>[1] = {}) {
  const m = makeMonorepo({ ...BASE, ...extra }, opts);
  try {
    fn(m);
  } finally {
    m.cleanup();
  }
}

test('check:imports: bundler aliases, tsconfig paths and virtual modules are not undeclared; repeats are grouped once', () => {
  const imports = (names: string[]) => names.map((n) => `import '${n}';`).join('\n') + '\n';
  mono(
    {
      'apps/web/astro.config.mjs': "export default { output: 'static', vite: { resolve: { alias: { project: '/x', '@lib': '/y' } } } };\n",
      'apps/web/tsconfig.json': pj({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
      'apps/web/src/a.ts': imports(['project/foo', '@lib/bar', '~/baz', 'missing-pkg']),
      'apps/web/src/b.ts': imports(['missing-pkg']),
      'apps/web/src/c.ts': imports(['missing-pkg', 'virtual:thing']),
      'apps/web/src/d.ts': imports(['missing-pkg']),
    },
    (m) => {
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1, r.output);
      assert.doesNotMatch(r.output, /"project"|@lib|"~\//, r.output);
      assert.equal((r.output.match(/missing-pkg/g) ?? []).length >= 1, true);
      assert.equal(r.output.split('\n').filter((l) => /^\s*•/.test(l) && /missing-pkg/.test(l)).length, 1, `one grouped finding:\n${r.output}`);
      assert.match(r.output, /"missing-pkg" 4x/, 'count is reported');
    },
    { config: append("virtualModules: ['virtual:*'],") }
  );
});

test('layersFile: shapes, short member names, devOnly tier, unknown shape errors clearly', () => {
  const files = {
    'packages/mocks/package.json': pj({ name: '@m/mocks', version: '1.0.0', exports: { '.': './src/i.ts' } }),
    'packages/mocks/src/i.ts': 'export const m = 1;\n',
  };
  const shapes: Array<[string, unknown]> = [
    ['objects', { layers: [{ name: 'base', members: ['ui'] }, { name: 'tooling', workspaces: ['mocks'], devOnly: true }, { name: 'apps', packages: ['web'] }] }],
    ['arrays', { layers: [['@m/ui'], ['mocks'], ['apps/web']] }],
    ['named', { _comment: 'x', base: ['ui'], tooling: ['mocks'], apps: ['web'] }],
  ];
  for (const [label, shape] of shapes) {
    mono({ ...files, 'scripts/module-layers.json': JSON.stringify(shape) }, (m) => {
      assert.match(fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8'), /layersFile: 'scripts\/module-layers\.json'/, label);
      assert.equal(m.run('check-imports.ts').status, 0, label);
      m.write('packages/ui/src/bad.ts', "import '@m/web';\n");
      const pkg = JSON.parse(fs.readFileSync(path.join(m.dir, 'packages/ui/package.json'), 'utf8'));
      pkg.dependencies = { '@m/web': '*' };
      m.write('packages/ui/package.json', pj(pkg));
      const r = m.run('check-imports.ts');
      assert.equal(r.status, 1, `${label}\n${r.output}`);
      assert.match(r.output, /layer/i);
    });
  }
  // devOnly: runtime dependency on a devOnly workspace fails; devDependency passes
  const layers = { layers: [{ name: 'tooling', workspaces: ['mocks'], devOnly: true }, { name: 'base', workspaces: ['ui'] }, { name: 'apps', workspaces: ['web'] }] };
  mono({ ...files, 'scripts/module-layers.json': JSON.stringify(layers) }, (m) => {
    const ui = JSON.parse(fs.readFileSync(path.join(m.dir, 'packages/ui/package.json'), 'utf8'));
    m.write('packages/ui/package.json', pj({ ...ui, dependencies: { '@m/mocks': '*' } }));
    const bad = m.run('check-imports.ts');
    assert.equal(bad.status, 1, bad.output);
    assert.match(bad.output, /devOnly/);
    m.write('packages/ui/package.json', pj({ ...ui, devDependencies: { '@m/mocks': '*' } }));
    assert.equal(m.run('check-imports.ts').status, 0);
  });
  mono({ ...files, 'scripts/module-layers.json': JSON.stringify({ layers: 'nope' }) }, (m) => {
    assert.doesNotMatch(fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8'), /layersFile:/);
    m.write('guardrails.config.ts', fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8').replace(/\n};\s*$/, "\n  layersFile: 'scripts/module-layers.json',\n};\n"));
    const r = m.run('check-imports.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /unknown layers shape/);
  });
});

test('doc-drift: bare filenames, app-relative paths, hyphenated identifiers, any-workspace scripts, planned dirs, gitignored files, routes tables', () => {
  mono(
    {
      'apps/web/src/lib/foo.ts': 'export const f = 1;\n',
      'apps/web/src/components/Faq.astro': '<p/>\n',
      'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts' }, scripts: { 'test:unit': 'node --test' } }),
      'apps/AGENTS.md': 'Use `lib/foo.ts` and `Faq.astro` and `index.astro` and `lib/gone.ts`. Use the replace-me-later package and `@m/replace-me-tool`.\nRun `npm run test:unit`. Needs `.dev.vars` and `secrets/key.pem` and `.cache/x.json`.\n',
      '.gitignore': '.cache/\n',
      'docs/migration/plan.md': 'Will add `src/new/thing.ts` and `apps/future/x.ts`.\n',
      'docs/plan-2/x.md': 'Will add `apps/future/y.ts`.\n',
      'README.md': '# R\n\n## Routes\n\n| Path | Notes |\n| --- | --- |\n| `/` | home |\n| `@m/ui` | not a route |\n| `Faq.astro` | not a route |\n| `/ghost` | dead |\n',
    },
    (m) => {
      const r = m.run('check-doc-drift.ts');
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, /lib\/gone\.ts/);
      for (const ok of [/lib\/foo\.ts/, /Faq\.astro/, /index\.astro/, /replace/i, /test:unit/, /\.dev\.vars/, /key\.pem/, /\.cache/, /src\/new\/thing/, /apps\/future/, /@m\/ui/]) {
        assert.doesNotMatch(r.output, ok, `${ok}\n${r.output}`);
      }
      assert.match(r.output, /\/ghost/);
    }
  );
  mono({ 'AGENTS.md': 'Please replace me with real text.\n' }, (m) => {
    assert.match(m.run('check-doc-drift.ts').output, /replace me/);
  });
});

test('check:gate: configured gate function is detected; result does not depend on dist', () => {
  const files = {
    'apps/web/src/middleware.ts': "import { checkGate } from '@m/ui';\nexport const onRequest = async (c, next) => { const g = checkGate(c.request); if (g) return g; return next(); };\n",
    'apps/web/wrangler.jsonc': '{ "name": "web", "assets": { "directory": "./dist/client", "run_worker_first": true } }\n',
  };
  mono(files, (m) => {
    const before = m.run('check-gate.ts');
    m.write('apps/web/dist/server/wrangler.json', '{ "name": "web", "assets": { "directory": "x" } }\n');
    m.write('apps/web/.wrangler/deploy/config.json', '{}\n');
    const after = m.run('check-gate.ts');
    assert.equal(after.status, before.status, `${before.output}\n---\n${after.output}`);
    assert.equal(after.output, before.output);
  }, { config: append("gate: { function: 'checkGate', from: '@m/ui' },") });
});

test('check:deps: outdatedPolicy major ignores minor/patch gaps, any reports them', () => {
  const fake = (m: Monorepo, latest: string) => {
    const bin = path.join(m.dir, 'fakebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = view ]; then echo '"${latest}"'; exit 0; fi\nif [ "$1" = audit ]; then echo '{"vulnerabilities":{}}'; exit 0; fi\nexit 0\n`, { mode: 0o755 });
    return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  };
  const files = { 'apps/web/package.json': pj({ name: '@m/web', version: '1.0.0', dependencies: { '@m/ui': '*', foo: '^1.0.0' }, scripts: { build: 'x', test: 'x' } }), 'node_modules/foo/package.json': pj({ name: 'foo', version: '1.0.0' }) };
  mono(files, (m) => {
    const r = m.run('check-deps.ts', ['--audit'], fake(m, '1.4.0'));
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /Mandatory Resolution|FORBIDDEN/);
  });
  mono(files, (m) => {
    const r = m.run('check-deps.ts', ['--audit'], fake(m, '1.4.0'));
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /fix: npm install foo@latest/);
  }, { config: (c) => c.replace(/^  dependencies: \{/m, "  dependencies: {\n    outdatedPolicy: 'any',") });
});

test('check:complexity: test files are excluded from advisories', () => {
  const big = Array.from({ length: 400 }, (_, i) => `if (x > ${i}) { y += ${i}; }`).join('\n');
  mono({ 'packages/ui/src/huge.test.ts': `let x = 1, y = 0;\n${big}\n` }, (m) => {
    const r = m.run('check-complexity.ts');
    assert.doesNotMatch(r.output, /huge\.test\.ts/);
  });
});

test('runner: output of a failing check is capped, the full report goes to .guardrails-cache/report.txt on --all', () => {
  const many = Array.from({ length: 60 }, (_, i) => `import 'nope-${i}';`).join('\n') + '\n';
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[`apps/web/src/f${i}.ts`] = `import 'nope-${i}';\n`;
  mono({ ...files, 'apps/web/src/many.ts': many }, (m) => {
    const r = m.npm(['run', 'guardrails', '--', '--all']);
    assert.equal(r.status, 1);
    const lines = r.output.split('\n').length;
    assert.ok(lines < 250, `bounded output (${lines} lines)`);
    assert.match(r.output, /report\.txt/);
    assert.ok(fs.existsSync(path.join(m.dir, '.guardrails-cache/report.txt')));
  });
});

test('runner: an existing root check script is reused for types; workspace test:unit and playwright dirs are discovered', () => {
  mono(
    { 'packages/ui/package.json': pj({ name: '@m/ui', version: '1.0.0', exports: { '.': './src/index.ts' }, scripts: { 'test:unit': 'node -e 0' } }) },
    (m) => {
      const root = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8'));
      assert.equal(root.scripts['check:types'], undefined, 'no second type chain');
      assert.equal(root.scripts['check:visual'], undefined, 'no root visual script without a root playwright config');
    },
    { rootPackage: { name: 'mono', private: true, type: 'module', workspaces: ['apps/*', 'packages/*'], scripts: { check: 'node -e 0' } } }
  );
});

test('bootstrap: finds Playwright specs in a workspace and wires visualSpecPath as a glob; stub only with --scaffold-specs', () => {
  const files = {
    'apps/web/src/components/Tog.astro': '<button id="t">x</button>\n<script>document.getElementById("t")</script>\n',
    'packages/qa/package.json': pj({ name: '@m/qa', version: '1.0.0', devDependencies: { '@playwright/test': '^1.40.0' }, scripts: { test: 'node --test' } }),
    'packages/qa/playwright.config.ts': "export default { testDir: './tests' };\n",
    'packages/qa/tests/tog.spec.ts': "page.locator('#t');\n",
  };
  mono(files, (m) => {
    assert.match(fs.readFileSync(path.join(m.dir, 'guardrails.config.ts'), 'utf8'), /visualSpecPath: 'packages\/qa\/tests\/\*\*\/\*\.spec\.\*'/);
    assert.equal(fs.existsSync(path.join(m.dir, 'tests/interactive.spec.ts')), false);
    const root = JSON.parse(fs.readFileSync(path.join(m.dir, 'package.json'), 'utf8'));
    assert.equal(root.scripts['check:visual'], undefined);
    const r = m.run('check-doc-drift.ts');
    assert.equal(r.status, 0, r.output);
  });
});

test('adopt mode: existing guards, layers file, ADR, non-GitHub CI, husky and AGENTS are respected; --patch-agents appends one line', () => {
  const files = {
    'scripts/module-layers.json': JSON.stringify({ layers: [{ name: 'base', workspaces: ['ui'] }, { name: 'apps', workspaces: ['web'] }] }),
    'scripts/guard.mjs': 'export {};\n',
    'docs/adr/0001-existing.md': '# existing\n',
    'Jenkinsfile': 'pipeline {}\n',
    '.husky/pre-push': 'echo hi\n',
    'AGENTS.md': '# Mine\n',
  };
  const m = makeMonorepo({ ...BASE, ...files }, { bootstrapArgs: ['--adopt', '--patch-agents'] });
  try {
    const read = (f: string) => fs.readFileSync(path.join(m.dir, f), 'utf8');
    const cfg = read('guardrails.config.ts');
    assert.match(cfg, /layersFile: 'scripts\/module-layers\.json'/);
    assert.match(cfg, /skipImportRules: \['layers', 'exports', 'declared'\]/);
    assert.match(cfg, /skipImportRulesReason: /);
    assert.equal(fs.existsSync(path.join(m.dir, 'docs/adr/0001-workspace-boundaries.md')), false);
    assert.equal(fs.existsSync(path.join(m.dir, '.github/workflows/guardrails.yml')), false);
    assert.equal(read('.husky/pre-push'), 'echo hi\n');
    assert.match(read('AGENTS.md'), /^# Mine\n[\s\S]*npm run guardrails/);
    assert.equal((read('AGENTS.md').match(/npm run guardrails/g) ?? []).length, 1);
    const again = spawnSync(process.execPath, [path.join(import.meta.dirname, '../scripts/bootstrap-repo.mjs'), '--target', m.dir, '--adopt', '--patch-agents'], { encoding: 'utf8' });
    assert.equal((read('AGENTS.md').match(/npm run guardrails/g) ?? []).length, 1, 'idempotent');
    assert.match(again.stdout, /Installed \/ skipped/);
    assert.match(again.stdout, /npm run guardrails/);
  } finally {
    m.cleanup();
  }
  // without --adopt nothing overlapping is skipped silently, and AGENTS.md is untouched
  const n = makeMonorepo({ ...BASE, ...files });
  try {
    assert.doesNotMatch(fs.readFileSync(path.join(n.dir, 'guardrails.config.ts'), 'utf8'), /^\s*skipImportRules:/m);
    assert.equal(fs.readFileSync(path.join(n.dir, 'AGENTS.md'), 'utf8'), '# Mine\n');
  } finally {
    n.cleanup();
  }
});

test('weakened: skipImportRules without a reason is reported', () => {
  mono({}, (m) => {
    assert.match(m.npm(['run', 'guardrails']).output, /skipImportRules \(layers\) skips check:imports rules without a skipImportRulesReason/);
  }, { config: append("skipImportRules: ['layers'],") });
  mono({}, (m) => {
    assert.doesNotMatch(m.npm(['run', 'guardrails']).output, /skipImportRules/);
  }, { config: append("skipImportRules: ['layers'], skipImportRulesReason: 'covered by an existing test',") });
});
