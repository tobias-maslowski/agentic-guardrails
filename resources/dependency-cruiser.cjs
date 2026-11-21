/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-be-pure',
      comment:
        'ADR-0001: src/domain/ must remain pure TypeScript. It cannot import from ui, storyblok, cms, worker, pages, or external runtime adapters.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/(ui|storyblok|cms|worker|pages)/' },
    },
    {
      name: 'cms-acl-depends-only-on-domain',
      comment:
        'ADR-0001: src/cms/ (CMS Anti-Corruption Layer) transforms external CMS bloks/stories into domain models and cannot depend on ui, storyblok wrappers, worker, or pages.',
      severity: 'error',
      from: { path: '^src/cms/' },
      to: { path: '^src/(ui|storyblok|worker|pages)/' },
    },
    {
      name: 'ui-must-be-cms-and-worker-agnostic',
      comment:
        'ADR-0001: src/ui/ presentation components must not import worker, cms internals, storyblok wrappers, or pages. Share contracts via src/domain/.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/(worker|cms|storyblok|pages)/' },
    },
    {
      name: 'storyblok-wrappers-cannot-import-worker-or-pages',
      comment:
        'ADR-0001: src/storyblok/ wrappers bridge CMS bloks to src/ui/ components and cannot import from worker or pages.',
      severity: 'error',
      from: { path: '^src/storyblok/' },
      to: { path: '^src/(worker|pages)/' },
    },
    {
      name: 'worker-cannot-import-ui-or-cms',
      comment:
        'ADR-0001: src/worker/ handles edge runtime logic and cannot depend on presentation components (ui/storyblok), cms loaders, or pages.',
      severity: 'error',
      from: { path: '^src/worker/' },
      to: { path: '^src/(ui|storyblok|cms|pages)/' },
    },
    {
      name: 'no-circular-dependencies',
      comment: 'ADR-0001: Circular dependencies between modules are forbidden.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
