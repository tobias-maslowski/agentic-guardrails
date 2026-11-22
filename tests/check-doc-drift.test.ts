import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeProject, type Project } from './helpers.ts';

let project: Project;
afterEach(() => project?.cleanup());

const agents = (...entries: string[]): string =>
  `# UI\n\n## Exported Modules\n${entries.map((e) => `- \`${e}\``).join('\n')}\n`;

function setConfig(p: Project, from: string, to: string): void {
  const file = path.join(p.dir, 'guardrails.config.ts');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `config lacks ${from}`);
  fs.writeFileSync(file, src.replace(from, to));
}

const drift = (p: Project) => p.run('check-doc-drift.ts');

describe('check-doc-drift', () => {
  it('flags undocumented nested files and does not bleed later bullets into ghost entries', () => {
    project = makeProject();
    project.write('src/ui/AGENTS.md', agents('Card.astro') + '\n## Notes\n- `ghost.ts`\n');
    project.write('src/ui/Card.astro', '<div></div>');
    project.write('src/ui/nested/Foo.astro', '<div></div>');
    const r = drift(project);
    assert.equal(r.status, 1);
    assert.match(r.output, /Undocumented File.*src\/ui\/nested\/Foo\.astro/);
    assert.doesNotMatch(r.output, /Ghost Entry/);

    project.write('src/ui/AGENTS.md', agents('Card.astro', 'nested/Foo.astro').replace(/\n/g, '\r\n'));
    assert.equal(drift(project).status, 0, drift(project).output);
  });

  it('parses imports with the TS AST: comments ignored; dynamic, side-effect, barrel imports caught', () => {
    project = makeProject();
    project.write('src/ui/AGENTS.md', agents('A.astro'));
    project.write(
      'src/ui/A.astro',
      `---\n// import x from '../worker/x';\n/* import '../cms/y'; */\nconst n = 1;\n---\n<p>{n}</p>`
    );
    assert.equal(drift(project).status, 0, drift(project).output);

    project.write('src/ui/AGENTS.md', agents('A.astro', 'B.astro'));
    project.write(
      'src/ui/B.astro',
      `---\nimport '../pages/side';\nimport { w } from '../worker';\nconst m = await import('../cms/dyn');\n---\n<script>import '@storyblok/astro';</script>`
    );
    const r = drift(project);
    assert.equal(r.status, 1);
    for (const spec of ['../pages/side', '../worker', '../cms/dyn', '@storyblok/astro']) {
      assert.ok(r.output.includes(`"${spec}"`), `missing violation for ${spec}\n${r.output}`);
    }
  });

  it('requires an existing visual spec and checks selector values, not attribute names', () => {
    project = makeProject();
    setConfig(project, 'visualSpecPath: null', "visualSpecPath: 'tests/visual-ui.spec.ts'");
    project.write('src/ui/AGENTS.md', agents('Btn.astro'));
    project.write('src/ui/Btn.astro', `<button data-testid="save-btn">Save</button>`);
    let r = drift(project);
    assert.match(r.output, /Missing Visual Spec/);

    project.write('tests/visual-ui.spec.ts', `// data-testid save-btn\nimport '@playwright/test';\n`);
    r = drift(project);
    assert.match(r.output, /Untested Interactive UI/);

    project.write('tests/visual-ui.spec.ts', `page.getByTestId('other');\npage.locator('[data-testid="save-btn"]');\n`);
    assert.equal(drift(project).status, 0, drift(project).output);

    project.write('src/ui/Btn.astro', `<button>Save</button>`);
    r = drift(project);
    assert.match(r.output, /Untested Interactive UI.*data-testid/);
  });

  it('requires a real storyblokEditable call in wrappers', () => {
    project = makeProject({ preset: 'storyblok' });
    for (const dir of ['cms', 'storyblok', 'ui', 'worker', 'domain']) {
      project.write(`src/${dir}/AGENTS.md`, agents(dir === 'storyblok' ? 'Hero.astro' : ''));
    }
    project.write('src/storyblok/Hero.astro', `---\n// storyblokEditable(blok)\nconst { blok } = Astro.props;\n---\n<div />`);
    let r = drift(project);
    assert.equal(r.status, 1);
    assert.match(r.output, /src\/storyblok\/Hero\.astro is missing a real `storyblokEditable/);

    project.write('src/storyblok/Hero.astro', `---\nconst { blok } = Astro.props;\n---\n<div {...storyblokEditable(blok)} />`);
    assert.doesNotMatch(drift(project).output, /Visual Editor Drift/);
  });

  it('only reads applies_to/enforced_by in ADR frontmatter and handles quotes and comments', () => {
    project = makeProject();
    project.write('src/ui/AGENTS.md', agents());
    project.write('docs/adr/0002.md', `---\r\ntags:\r\n  - not-a-path\r\napplies_to: [src/ui, "src/domain"] # ok\r\nenforced_by: 'scripts/check-doc-drift.ts' # script\r\n---\r\nbody`);
    const r = drift(project);
    assert.doesNotMatch(r.output, /Stale ADR Reference/, r.output);
  });

  it('checks every <style> block and escapes prefixes', () => {
    project = makeProject();
    setConfig(project, 'forbiddenGlobalClassPrefixes: []', "forbiddenGlobalClassPrefixes: ['card+']");
    project.write('src/ui/AGENTS.md', agents());
    project.write('src/pages/index.astro', `<style>.ok{}</style>\n<style>.card+x{}</style>`);
    const r = drift(project);
    assert.equal(r.status, 1);
    assert.match(r.output, /Style Encapsulation Violation/);
  });
});
