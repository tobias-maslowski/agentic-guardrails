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
   * Directories that require a scoped `AGENTS.md` with an `## Exported Modules` registry.
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
  visualSpecPath: string | null;

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
  uiTriggerPatterns: [/^src\/ui\//, /^src\/storyblok\//, /^src\/pages\/index\.astro$/, /^tests\//],
  // Set to your Playwright spec (and install @playwright/test) to enable interactive-selector coverage and `check:visual`.
  visualSpecPath: null,
  globalLayoutAstroPath: 'src/pages/index.astro',
  forbiddenGlobalClassPrefixes: [],
  dependencies: {
    failOnVulnerabilitySeverity: 'high',
    failOnOutdated: true,
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
