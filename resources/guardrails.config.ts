export interface BannedPackageRule {
  name: string;
  replacement: string;
}

export interface AcknowledgedDependencyAdvisory {
  /** Package name in package.json or transitive dependency tree */
  package: string;
  /**
   * Scope of exception:
   * - `'outdated'`: Acknowledges a version pin only (NEVER silences a security CVE).
   * - `'cve'`: Acknowledges a specific security vulnerability (requires `ghsaId`).
   */
  kind: 'outdated' | 'cve';
  /** Required when `kind === 'cve'` (e.g. `'GHSA-88gm-j2wx-58h6'`) so version pins never mask security CVEs */
  ghsaId?: string;
  /** Explicit engineering reason why this CVE or version pin cannot be upgraded immediately */
  reason: string;
}

export interface GuardrailsConfig {
  /**
   * Monorepo mode (npm workspaces): workspace globs relative to the repo root (e.g. `['apps/*', 'packages/*']`).
   * When set, every check iterates over the matching directories that contain a package.json, and
   * `scopedModules` / `extraComplexityScanDirs` / `archDirs` are resolved inside each workspace.
   * Leave undefined for a single-package repo.
   */
  workspaces?: string[];

  /**
   * Workspace layers, low -> high (monorepo mode). A workspace may only import workspaces of strictly lower layers.
   * Entries are package names, workspace directories or `*` globs of directories.
   * Either `string[][]` or `{ name, workspaces }[]`. When set, every workspace must be listed.
   */
  layers?: string[][] | Array<{ name: string; workspaces: string[] }>;

  /**
   * Existing layers file (root-relative JSON, e.g. `scripts/module-layers.json`) read instead of `layers`.
   * Shapes: `{ layers: [{ name, workspaces|members|packages, devOnly? }] }`, `{ layers: [[...]] }`, or an object name -> array (low -> high).
   * A `devOnly` layer may be depended on only through devDependencies/peerDependencies.
   */
  layersFile?: string;

  /** Adopt mode: `check:imports` rules ('layers' | 'exports' | 'declared') skipped because existing tests already enforce them; requires `skipImportRulesReason`. */
  skipImportRules?: string[];
  skipImportRulesReason?: string;

  /** Root-relative dir globs whose docs describe planned structure: dead-path claims there are not checked. Default `['docs/migration', 'docs/plan*', 'docs/adr']`. */
  plannedPathDirs?: string[];

  /** Site-wide access gate detection: `{ file?, status?, function?, from? }` (`function`/`from`: an imported gate function called in a middleware/worker entry). */
  gate?: { file?: string | string[]; status?: number | number[]; function?: string; from?: string };

  /** Extra directory names skipped by `check:imports` (defaults already skip node_modules, dist, build, coverage, out and dot-dirs). */
  importScanIgnoreDirs?: string[];

  /** Directories (relative to each project) cruised by `check:arch` / dependency-cruiser. Default `['src']`. */
  archDirs?: string[];

  /** Gates (npm script names) that must exist and pass. Default: check:arch, check:drift, check:complexity, check:deps (+ check:imports in monorepo mode). */
  requiredGates?: string[];

  /** Gates run when their script exists (root, or any workspace in monorepo mode). Default: check:ssr, build, check:types, typecheck, test. */
  optionalGates?: string[];

  /** Monorepo mode: fail when no `test` script exists in the root or any workspace. Default true; set false to opt out. */
  requireTests?: boolean;

  /** Fail (instead of advisory) when `.astro` files have a `<script>` or `client:*` directive and `visualSpecPath` is null. Default: true in monorepo mode, false otherwise. */
  requireInteractiveSpecs?: boolean;

  /** Require at least one decision record (`docs/adr/*.md`, not an AGENTS.md). Default: true in monorepo mode, false otherwise. */
  requireAdr?: boolean;

  /** Monorepo mode: per-workspace-group import bans for external/builtin specifiers. `forbid`/`allowOnly` are globs (`node:*`, `@storyblok/*`). */
  externalRules?: Array<{ workspaces: string[]; forbid?: string[]; allowOnly?: string[] }>;

  /** Virtual modules (e.g. `virtual:foo`) exempt from the undeclared-dependency check. */
  virtualModules?: string[];

  /**
   * Test files (root-relative globs) exempt from `externalRules` and the undeclared-package check of `check:imports`, so a
   * pure package can co-locate `node:test` suites. Default: `**\/*.test.*`, `**\/*.spec.*`, `**\/test/**`, `**\/tests/**`, `**\/__tests__/**`.
   */
  testGlobs?: string[];

  /** Fast-tier time budget in ms; the runner warns above it (default 10000). */
  fastTierBudgetMs?: number;

  /** Doc path/route claims (globs with `*`) that are deliberately not on disk. */
  docClaimsAllow?: string[];

  /** Required together with `weakenedConfigReason` to accept a config that disables or narrows checks. */
  allowWeakenedConfig?: boolean;
  weakenedConfigReason?: string;

  /**
   * Directories that require a scoped `AGENTS.md` with an `## Exported Modules` registry.
   * In monorepo mode these are resolved inside every workspace and skipped where they do not exist.
   */
  scopedModules: string[];

  /**
   * Optional additional directories scanned by the TypeScript & Astro AST Complexity Advisor
   * beyond `scopedModules` (defaults to `['src/pages', 'public']`).
   */
  extraComplexityScanDirs?: string[];

  /**
   * RegExp patterns that trigger `npm run check:visual` (Playwright)
   * when changed in the working tree (`git status`) or, with `--base <ref>`, in `<ref>...HEAD`.
   */
  uiTriggerPatterns: RegExp[];

  /**
   * Path to the Playwright visual/behavioral spec file used to verify interactive UI selectors.
   * Set to null to disable interactive selector coverage verification.
   */
  visualSpecPath: string | string[] | null;

  /**
   * Global layout / entry `.astro` file checked for leaked component-specific CSS selectors.
   */
  globalLayoutAstroPath: string | null;

  /**
   * Component-specific CSS class prefixes that must NOT appear in `globalLayoutAstroPath`.
   */
  forbiddenGlobalClassPrefixes: string[];

  /**
   * Optional Storyblok CMS enterprise guardrails.
   */
  storyblok?: {
    /** Directory containing Storyblok wrapper `.astro` components (e.g. `src/storyblok`). */
    wrapperDir: string;
    /** Require every wrapper component in `wrapperDir` to call `storyblokEditable`. */
    requireStoryblokEditable: boolean;
  };

  /**
   * Deterministic dependency hygiene, security vulnerability gate, and freshness configuration.
   */
  dependencies?: {
    /**
     * Minimum vulnerability severity that causes a deterministic exit(1) failure (`'critical' | 'high' | 'moderate' | 'none'`).
     * Defaults to `'high'`.
     */
    failOnVulnerabilitySeverity: 'critical' | 'high' | 'moderate' | 'none';
    /**
     * When true, outdated direct dependencies in `package.json` cause a deterministic exit(1) failure
     * unless upgraded in `package.json`.
     */
    failOnOutdated: boolean;
    /** Which gap to the latest release fails: 'major' (default), 'minor' or 'any'. Smaller gaps are only counted. */
    outdatedPolicy?: 'major' | 'minor' | 'any';
    /** Timeout for each `npm audit` / `npm outdated` call in `--audit` mode (default 30000). A timeout fails closed. */
    auditTimeoutMs?: number;
    /**
     * Human-approved exception list for unpatched upstream CVEs or pinned major versions.
     * Agents are forbidden from adding entries here without first attempting a real upgrade and reporting the failure.
     */
    acknowledgedAdvisories: AcknowledgedDependencyAdvisory[];
    /**
     * Packages that agents must not install because modern Web/Node/Worker built-ins exist.
     */
    bannedPackages: BannedPackageRule[];
  };

  /**
   * Brownfield / Enterprise Ratchet Mode:
   * When true, `check:complexity` only reports advisories on changed files (`git status`, plus `--base <ref>` for CI).
   * If git is unavailable it warns and analyses all files.
   */
  ratchetChangedFilesOnly: boolean;

  /**
   * When true, `check:complexity` exits 1 if any advisory is reported (after ratchet filtering).
   * Defaults to false: advisories are informational.
   */
  failOnComplexityAdvisories?: boolean;

  /**
   * AST Complexity & Smell Advisory Thresholds.
   */
  thresholds: {
    functionCognitive: number;
    functionCyclomatic: number;
    astroScriptMaxStatements: number;
    astroScriptMaxCognitive: number;
  };
}

export const guardrailsConfig: GuardrailsConfig = {
  scopedModules: ['src/domain', 'src/worker', 'src/ui'],
  extraComplexityScanDirs: ['src/pages', 'public'],
  // The ADR names the optional CMS layers; they only exist with the Storyblok preset.
  docClaimsAllow: ['src/cms/', 'src/storyblok/'],
  uiTriggerPatterns: [/^src\/ui\//, /^src\/storyblok\//, /^src\/pages\/index\.astro$/, /(^|\/)src\/.*\.astro$/, /^tests\//, /(^|\/)src\/.*(session|auth|cookie|middleware|mapper)/i],
  // Set to your Playwright spec (and install @playwright/test) to enable interactive-selector coverage and `check:visual`.
  visualSpecPath: null,
  globalLayoutAstroPath: 'src/pages/index.astro',
  forbiddenGlobalClassPrefixes: [],
  dependencies: {
    failOnVulnerabilitySeverity: 'high',
    failOnOutdated: true,
    auditTimeoutMs: 30000,
    acknowledgedAdvisories: [],
    bannedPackages: [
      { name: 'node-fetch', replacement: 'Built-in global `fetch()`' },
      { name: 'axios', replacement: 'Built-in global `fetch()`' },
      { name: 'uuid', replacement: 'Built-in Web Crypto `crypto.randomUUID()`' },
      { name: 'crypto-js', replacement: 'Built-in Web Crypto `crypto.subtle`' },
      { name: 'moment', replacement: 'Built-in `Intl.DateTimeFormat` or native `Date`' },
      { name: 'lodash', replacement: 'Native ES2024+ Array/Object methods' },
      { name: 'underscore', replacement: 'Native ES2024+ Array/Object methods' },
    ],
  },
  ratchetChangedFilesOnly: false,
  failOnComplexityAdvisories: false,
  thresholds: {
    functionCognitive: 15,
    functionCyclomatic: 12,
    astroScriptMaxStatements: 25,
    astroScriptMaxCognitive: 12,
  },
};
