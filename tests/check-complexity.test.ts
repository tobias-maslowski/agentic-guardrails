import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeProject, type Project } from './helpers.ts';

const COMPLEX_BODY = `
  if (a) { if (b) { if (c) { if (d) { if (e) { return 1; } } } } }
  for (const x of [a, b]) { if (x) { while (c) { if (d) { return 2; } } } }
  return a && b && c ? 1 : 0;
`;

const COMPLEX_METHOD = `export class Svc {
  run(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {${COMPLEX_BODY}}
}
`;

const projects: Project[] = [];
function project(opts: Parameters<typeof makeProject>[0] = {}): Project {
  const p = makeProject(opts);
  projects.push(p);
  return p;
}
afterEach(() => {
  while (projects.length) projects.pop()?.cleanup();
});

function patchConfig(p: Project, from: string, to: string) {
  const file = path.join(p.dir, 'guardrails.config.ts');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `config should contain ${from}`);
  p.write('guardrails.config.ts', src.replace(from, to));
}

function git(p: Project, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: p.dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function commitAll(p: Project) {
  p.write('.gitignore', 'node_modules\n');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
}

describe('check-complexity', () => {
  it('reports a complex class method', () => {
    const p = project();
    p.write('src/domain/svc.ts', COMPLEX_METHOD);
    const r = p.run('check-complexity.ts');
    assert.equal(r.status, 0);
    assert.match(r.output, /High Function Complexity/);
    assert.match(r.output, /Svc\.run\(\)/);
  });

  it('exits 1 on advisories only when failOnComplexityAdvisories is set', () => {
    const p = project();
    p.write('src/domain/svc.ts', COMPLEX_METHOD);
    assert.equal(p.run('check-complexity.ts').status, 0);
    patchConfig(p, 'failOnComplexityAdvisories: false', 'failOnComplexityAdvisories: true');
    const r = p.run('check-complexity.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /failOnComplexityAdvisories/);
  });

  it('flags real browser globals in imported SSR modules but not keys or typeof guards', () => {
    const p = project();
    p.write(
      'src/domain/clean.ts',
      `export const cfg = { window: 1, document: 2 };
export const isBrowser = typeof window !== 'undefined';
export function f(navigator: string) { return navigator; }
export interface Shape { document: string }
`
    );
    p.write('src/domain/dirty.ts', `export function title() { return document.title; }\n`);
    p.write('src/domain/index.ts', `export * from './dirty.ts';\n`);
    p.write(
      'src/pages/clean.astro',
      `---\nimport { cfg } from '../domain/clean.js';\n---\n<p>{cfg.window}</p>\n`
    );
    p.write(
      'src/pages/dirty.astro',
      `---\nimport { title } from '../domain/index.ts';\n---\n<p>{title()}</p>\n`
    );
    const r = p.run('check-complexity.ts');
    assert.match(r.output, /dirty\.astro/);
    assert.match(r.output, /src\/domain\/dirty\.ts \(document\)/);
    assert.doesNotMatch(r.output, /clean\.astro/);
  });

  it('ratchet mode handles filenames with spaces and keeps clones when any member changed', () => {
    const p = project({ git: true });
    const clone = `export function build(items: string[]) {
  const label = items.length > 0 ? items.map((item) => item.trim()).join(', ') : 'nothing selected';
  const total = typeof items === 'object' ? items.length : 0;
  return label + total;
}
`;
    p.write('src/domain/big file.ts', COMPLEX_METHOD);
    p.write('src/domain/other.ts', COMPLEX_METHOD.replace('Svc', 'Other'));
    p.write('src/domain/a.ts', clone);
    p.write('src/domain/b.ts', clone.replace('build', 'build2'));
    commitAll(p);
    patchConfig(p, 'ratchetChangedFilesOnly: false', 'ratchetChangedFilesOnly: true');

    const clean = p.run('check-complexity.ts');
    assert.doesNotMatch(clean.output, /Svc\.run|Other\.run|Cross-File/);

    p.write('src/domain/big file.ts', `${COMPLEX_METHOD}// touched\n`);
    p.write('src/domain/b.ts', `${clone.replace('build', 'build2')}// touched\n`);
    const r = p.run('check-complexity.ts');
    assert.match(r.output, /Svc\.run\(\)/);
    assert.doesNotMatch(r.output, /Other\.run\(\)/);
    assert.match(r.output, /Cross-File Logic Duplication/);
  });
});
