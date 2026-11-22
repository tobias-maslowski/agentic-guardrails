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

/**
 * Layer rules are generated for the `src/<layer>/` folders that actually exist in the project the cruiser runs in
 * (cwd = the project / workspace directory), and match at any depth: `(^|/)src/<layer>/`.
 * Missing folders get no rule, so a green run never claims a boundary that has nothing behind it.
 * Package-name bans (`@storyblok/*`, `@cloudflare/*`, `node:*`) match resolved AND unresolved npm modules;
 * monorepo workspaces additionally get `externalRules` in check:imports.
 */
const LAYERS = ['domain', 'ui', 'storyblok', 'cms', 'worker', 'pages'];
const present = new Set(LAYERS.filter((d) => fs.existsSync(`${process.cwd()}/src/${d}`)));
const dir = (d) => `(^|/)src/${d}/`;
const anyOf = (list) => `(^|/)src/(${list.join('|')})/`;

const rules = [];
const rule = (layer, r) => {
  if (present.has(layer)) rules.push(r);
};

rule('domain', {
  name: 'domain-must-be-pure',
  comment: 'ADR-0001: src/domain/ must remain pure TypeScript. It cannot import from ui, storyblok, cms, worker, or pages.',
  severity: 'error',
  from: { path: dir('domain') },
  to: { path: anyOf(['ui', 'storyblok', 'cms', 'worker', 'pages']) },
});
rule('domain', {
  name: 'domain-no-external-runtime-packages',
  comment:
    'ADR-0001: src/domain/ must not import external runtime packages or Node core modules. To allow a specific package, add it to ALLOWED_DOMAIN_PACKAGES in this file (human-approved).',
  severity: 'error',
  from: { path: dir('domain') },
  to: {
    dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown', 'core'],
    ...(allowedDomainPackagesPattern ? { pathNot: allowedDomainPackagesPattern } : {}),
  },
});
rule('cms', {
  name: 'cms-acl-depends-only-on-domain',
  comment:
    'ADR-0001: src/cms/ (CMS Anti-Corruption Layer) transforms external CMS bloks/stories into domain models and cannot depend on ui, storyblok wrappers, worker, or pages.',
  severity: 'error',
  from: { path: dir('cms') },
  to: { path: anyOf(['ui', 'storyblok', 'worker', 'pages']) },
});
rule('ui', {
  name: 'ui-must-be-cms-and-worker-agnostic',
  comment: 'ADR-0001: src/ui/ presentation components must not import worker, cms internals, storyblok wrappers, or pages. Share contracts via src/domain/.',
  severity: 'error',
  from: { path: dir('ui') },
  to: { path: anyOf(['worker', 'cms', 'storyblok', 'pages']) },
});
rule('ui', {
  name: 'ui-no-cms-or-edge-sdk-packages',
  comment: 'ADR-0001: src/ui/ must not import CMS SDK (@storyblok/*) or Cloudflare (@cloudflare/*) packages; do that in src/storyblok/ or src/worker/.',
  severity: 'error',
  from: { path: dir('ui') },
  to: { path: '(^|/)@(storyblok|cloudflare)/' },
});
rule('storyblok', {
  name: 'storyblok-wrappers-cannot-import-worker-or-pages',
  comment: 'ADR-0001: src/storyblok/ wrappers bridge CMS bloks to src/ui/ components and cannot import from worker or pages.',
  severity: 'error',
  from: { path: dir('storyblok') },
  to: { path: anyOf(['worker', 'pages']) },
});
rule('worker', {
  name: 'worker-cannot-import-ui-or-cms',
  comment: 'ADR-0001: src/worker/ handles edge runtime logic and cannot depend on presentation components (ui/storyblok), cms loaders, or pages.',
  severity: 'error',
  from: { path: dir('worker') },
  to: { path: anyOf(['ui', 'cms', 'storyblok', 'pages']) },
});
rules.push({
  name: 'no-circular-dependencies',
  comment: 'ADR-0001: Circular dependencies between modules are forbidden.',
  severity: 'error',
  from: {},
  to: { circular: true },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: rules,
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    // type-only imports do not create runtime cycles
    tsPreCompilationDeps: false,
    ...(fs.existsSync('tsconfig.json') ? { tsConfig: { fileName: 'tsconfig.json' } } : {}),
  },
};
