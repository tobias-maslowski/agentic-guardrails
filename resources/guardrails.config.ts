export interface GuardrailsConfig {
  /**
   * Directories that require a scoped `AGENTS.md` with an `## Exported Modules` registry.
   */
  scopedModules: string[];

  /**
   * Directories scanned by the TypeScript & Astro AST Complexity & Smell Advisor.
   */
  complexityScanDirs: string[];

  /**
   * Regex patterns (as strings) that trigger `npm run check:visual` (Playwright)
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
  complexityScanDirs: ['src/domain', 'src/worker', 'src/ui', 'src/pages', 'public'],
  uiTriggerPatterns: [/^src\/ui\//, /^src\/storyblok\//, /^src\/pages\/index\.astro$/, /^tests\//],
  visualSpecPath: 'tests/visual-ui.spec.ts',
  globalLayoutAstroPath: 'src/pages/index.astro',
  forbiddenGlobalClassPrefixes: [
    'passport-',
    'tactics-',
    'telemetry-',
    'hero-',
    'project-',
    'spec-bar',
  ],
  ratchetChangedFilesOnly: false,
  thresholds: {
    functionCognitive: 15,
    functionCyclomatic: 12,
    astroScriptMaxStatements: 25,
    astroScriptMaxCognitive: 12,
  },
};
