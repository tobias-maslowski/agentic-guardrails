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
      name: 'ui-cannot-import-worker-or-cms-internals',
      comment:
        'ADR-0001: src/ui/ presentation components must not directly import worker or CMS client internals. Share contracts via src/domain/.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/(worker|cms)/' },
    },
    {
      name: 'worker-cannot-import-ui',
      comment:
        'ADR-0001: src/worker/ handles edge runtime logic and cannot depend on presentation components in src/ui/ or src/storyblok/.',
      severity: 'error',
      from: { path: '^src/worker/' },
      to: { path: '^src/(ui|storyblok)/' },
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
