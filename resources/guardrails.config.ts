export interface BannedPackageRule {
  name: string;
  replacement: string;
}

export interface AcknowledgedDependencyAdvisory {
  /** Package name in package.json or transitive dependency tree */
  package: string;
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
   * when modified in `git status --porcelain`.
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
     * unless upgraded or explicitly recorded in `acknowledgedAdvisories`.
     */
    failOnOutdated: boolean;
    /**
     * Explicit, auditable exception list for upstream CVEs or pinned major versions that cannot be upgraded yet.
     */
    acknowledgedAdvisories: AcknowledgedDependencyAdvisory[];
    /**
     * Packages that agents must not install because modern Web/Node/Worker built-ins exist.
     */
    bannedPackages: BannedPackageRule[];
  };

  /**
   * Brownfield / Enterprise Ratchet Mode:
   * When true, `check:complexity` only reports advisories on files modified in `git status`.
   */
  ratchetChangedFilesOnly: boolean;

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
  visualSpecPath: 'tests/visual-ui.spec.ts',
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
  thresholds: {
    functionCognitive: 15,
    functionCyclomatic: 12,
    astroScriptMaxStatements: 25,
    astroScriptMaxCognitive: 12,
  },
};
