const fs = require('node:fs');

/**
 * npm packages that src/domain/ may import (e.g. pure validation libs such as 'zod').
 * Add names here deliberately; everything else (including node: core modules) is forbidden in the domain.
 */
const ALLOWED_DOMAIN_PACKAGES = [];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const allowedDomainPackagesPattern = ALLOWED_DOMAIN_PACKAGES.length
  ? `node_modules/(${ALLOWED_DOMAIN_PACKAGES.map(escapeRe).join('|')})(/|$)`
  : undefined;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-be-pure',
      comment:
        'ADR-0001: src/domain/ must remain pure TypeScript. It cannot import from ui, storyblok, cms, worker, or pages.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/(ui|storyblok|cms|worker|pages)/' },
    },
    {
      name: 'domain-no-external-runtime-packages',
      comment:
        'ADR-0001: src/domain/ must not import external runtime packages or Node core modules. To allow a specific package, add it to ALLOWED_DOMAIN_PACKAGES in this file (human-approved).',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'core'],
        ...(allowedDomainPackagesPattern ? { pathNot: allowedDomainPackagesPattern } : {}),
      },
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
      name: 'ui-no-cms-or-edge-sdk-packages',
      comment:
        'ADR-0001: src/ui/ must not import CMS SDK (@storyblok/*) or Cloudflare (@cloudflare/*) packages; do that in src/storyblok/ or src/worker/.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '(^|/)node_modules/@(storyblok|cloudflare)/' },
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
    ...(fs.existsSync('tsconfig.json') ? { tsConfig: { fileName: 'tsconfig.json' } } : {}),
  },
};
