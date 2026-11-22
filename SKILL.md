---
name: agentic-guardrails
description: >-
  Bootstrap, audit, or tighten deterministic AI coding guardrails in TypeScript,
  Astro, Storyblok CMS, and Edge/Worker repositories. Use when setting up a
  progressive AGENTS.md / CLAUDE.md context router, Agent-Optimized ADRs,
  dependency-cruiser module boundaries, doc-drift verification, diff-aware
  Playwright visual gates, or AST code complexity and smell advisories.
---

# Agentic Guardrails Skill (Copilot · Claude Code · Antigravity)

This skill enforces **five core engineering invariants** without bloating the agent's context window with prose rules:
1. **Progressive Context Routing (<35-line root `AGENTS.md` + `CLAUDE.md` & `.github/copilot-instructions.md` bridges):** Agents load only the scoped `src/<layer>/AGENTS.md` and ADRs relevant to their task (~1,200–1,400 tokens total).
2. **Deterministic Module Boundaries (`.dependency-cruiser.cjs` + `.astro` import checker):** Prevents cross-layer coupling across both 3-layer (`domain`, `worker`, `ui`) and Enterprise Storyblok (`domain`, `cms`, `storyblok`, `ui`, `worker`, `pages`) stacks.
3. **Zero Doc-Drift & Interactive UI Coverage (`scripts/check-doc-drift.ts`):** Verifies every file in `scopedModules` is registered in its folder's `AGENTS.md`, every ADR `applies_to` path exists on disk, every interactive UI component (`<button>` / `<script>`) has selector coverage in Playwright, and (when `storyblok` is enabled) every wrapper in `src/storyblok/*.astro` calls `storyblokEditable(blok)`.
4. **AST Complexity & Architectural Smell Advisor (`scripts/check-complexity.ts`):** Uses the TypeScript Compiler AST (`ts.createSourceFile`) to advise when to introduce abstraction layers—catching high Cognitive/Cyclomatic complexity, fat inline `.astro` `<script>` blocks, SSR $\leftrightarrow$ Client `.innerHTML` dual-render duplication, SSR frontmatter browser-global impurity (`document`/`window`/`navigator` in edge SSR), cross-file logic clones, and inline type-cast escapes (`as any`, `as { ... }`).
5. **Two-Tier Dependency Hygiene, Security CVE & Freshness Guardrail (`scripts/check-deps.ts`):**
   - *Tier 1 (Always runs in <20ms):* Flags redundant legacy packages where built-in Web/Worker APIs exist (`axios`, `node-fetch`, `uuid`, `crypto-js`, `moment`, `lodash`) and unpinned `"*"` / `"latest"` versions.
   - *Tier 2 (Auto-runs when `package.json` / lockfile changes or `--all`):* Runs `npm audit --json` and `npm outdated --json` to surface known security CVEs, available fixes, and training-cutoff version lag (agents must warn the user about any reported security gaps).

---

## Workflow A: Bootstrapping Guardrails in a New or Existing Repository

When asked to bootstrap or set up agentic guardrails in a project:

### Step 1: Run the Self-Contained Bootstrapper CLI
Run `scripts/bootstrap-repo.mjs` from this skill directory. Pass `--preset storyblok` (5 scoped modules plus `src/pages`) for Storyblok CMS architectures (or default `--preset standard` for 3-layer apps):

```bash
# For Enterprise Storyblok + Astro + Edge/Worker projects:
node <path-to-this-skill>/scripts/bootstrap-repo.mjs --target /path/to/target-repo --preset storyblok

# For Standard 3-Layer (domain / worker / ui) projects:
node <path-to-this-skill>/scripts/bootstrap-repo.mjs --target /path/to/target-repo
```

The bootstrapper automatically:
- Creates the target directory (if needed) and installs `guardrails.config.ts`, `scripts/run-guardrails.ts`, `scripts/git-changes.ts`, `scripts/check-doc-drift.ts`, `scripts/check-complexity.ts`, `scripts/check-deps.ts`, and `.dependency-cruiser.cjs`.
- Validates `package.json` before writing anything, rejects unknown presets, and never overwrites existing files without `--force`.
- Installs `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `.github/copilot-instructions.md`, `docs/adr/0001-layered-modular-boundaries.md`, and starter `src/<layer>/AGENTS.md` files for every configured module.
- Extends only the `exclude` list of `tsconfig.json` (if present and plain JSON) so `"scripts"` and `"guardrails.config.ts"` are excluded from Cloudflare Worker runtime typechecking (`@cloudflare/workers-types` vs Node CLI scripts).

### Step 2: Wire `package.json` Scripts & Playwright Config
1. The bootstrapper adds these scripts to `package.json` if missing (`check:types` only for Astro projects; verify them). In CI run `npm run guardrails -- --base origin/main` (clean working tree) and bootstrap per package inside npm workspaces. `check:deps --audit` fails closed when the audit cannot run. `visualSpecPath` is `null` by default; set it (and install `@playwright/test`) to enable Playwright gating:
   ```json
   {
     "scripts": {
       "check:arch": "depcruise src --config .dependency-cruiser.cjs",
       "check:drift": "node --experimental-strip-types scripts/check-doc-drift.ts",
       "check:complexity": "node --experimental-strip-types scripts/check-complexity.ts",
       "check:deps": "node --experimental-strip-types scripts/check-deps.ts",
       "check:visual": "playwright test",
       "check:types": "astro check && tsc --noEmit",
       "guardrails": "node --experimental-strip-types scripts/run-guardrails.ts"
     }
   }
   ```
2. If using `tsconfig.json` with `"types": ["@cloudflare/workers-types"]`, ensure `"exclude": ["dist", "node_modules", "scripts", "guardrails.config.ts", "playwright.config.ts", "tests"]` is set so Cloudflare Worker typechecking doesn't collide with Node CLI scripts.
3. In `playwright.config.ts` (template available at [resources/templates/playwright.config.ts](./resources/templates/playwright.config.ts)), point `webServer.url` to a project-specific route or API endpoint (e.g., `http://localhost:4321/api/...`) so `reuseExistingServer: true` never attaches to a different project's dev server.
4. Tailor `guardrails.config.ts` (`scopedModules`, `uiTriggerPatterns`, `forbiddenGlobalClassPrefixes`, `ratchetChangedFilesOnly`) and update `## Exported Modules` in each `src/<layer>/AGENTS.md`.
5. Run `npm run guardrails -- --all` and fix any drift or boundary violations until green.

---

## Workflow B: Post-Task Audit & `/learn` Tightening Loop

Whenever a code review or post-agent audit reveals a shortcut that slipped past `npm run guardrails`:

1. **Classify the Loophole:**
   - *Structural / Boundary Leak* (e.g., component styles dumped in global layout, or browser globals imported in SSR frontmatter)
   - *Semantic Leak* (e.g., domain constants hardcoded in worker/CMS layer, or missing `storyblokEditable(blok)` on a Storyblok wrapper)
   - *Complexity / Duplication Spike* (e.g., copy-pasted helper blocks or `CogC >= 15` function)
2. **Red Phase (Deterministic Check First — Avoid Prose Bloat):**
   - Add or tighten the check in `guardrails.config.ts`, `scripts/check-doc-drift.ts`, `scripts/check-complexity.ts`, or `.dependency-cruiser.cjs`.
   - Run `npm run guardrails` and verify it **fails (or emits the exact advisory)** against the current code.
3. **Scoped Context Update (Zero Root Bloat):**
   - If a new invariant needs documenting, add a 1-line constraint to the relevant `src/<module>/AGENTS.md`—keep the root `AGENTS.md` under 35 lines.
4. **Green Phase (Remediate & Verify):**
   - Refactor the code into clean abstractions, update `## Exported Modules` in the affected `src/<module>/AGENTS.md`, and run `npm run guardrails` until all checks and advisories are clean.
