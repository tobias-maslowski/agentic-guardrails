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

This skill enforces **four core engineering invariants** without bloating the agent's context window with prose rules:
1. **Progressive Context Routing (<35-line root `AGENTS.md` + `CLAUDE.md` bridge):** Agents load only the scoped `src/<layer>/AGENTS.md` and ADRs relevant to their task (~1,400 tokens total).
2. **Deterministic Module Boundaries (`.dependency-cruiser.cjs` + `.astro` import checker):** Prevents cross-layer coupling (e.g., `domain` importing outside `domain`, or `ui` importing `worker` / raw Storyblok CMS client internals).
3. **Zero Doc-Drift & Interactive UI Coverage (`scripts/check-doc-drift.ts`):** Verifies every file in scoped directories is registered in its folder's `AGENTS.md`, every ADR `applies_to` path exists on disk, and every interactive UI component (`<button>` / `<script>`) has selector coverage in Playwright.
4. **AST Complexity & Architectural Smell Advisor (`scripts/check-complexity.ts`):** Uses the TypeScript Compiler AST (`ts.createSourceFile`) to advise when to introduce abstraction layers—catching high Cognitive/Cyclomatic complexity, fat inline `.astro` `<script>` blocks, SSR $\leftrightarrow$ Client `.innerHTML` dual-render duplication, SSR frontmatter browser-global impurity (`document`/`window`/`navigator` in edge SSR), cross-file logic clones, and inline type-cast escapes (`as any`, `as { ... }`).

---

## Workflow A: Bootstrapping Guardrails in a New or Existing Repository

When asked to bootstrap or set up agentic guardrails in a project:

### Step 1: Inspect the Repository Layers
Identify the project's top-level architectural directories under `src/` (for example):
- **Standard App / Edge Bridge:** `src/domain`, `src/worker` (or `src/server`), `src/ui` (or `src/components`), `src/pages`
- **Enterprise Storyblok CMS Stack:** `src/domain`, `src/cms`, `src/storyblok`, `src/ui`, `src/worker`, `src/pages`

### Step 2: Install the Guardrail Scripts from `./resources/`
Run the zero-dependency bootstrapper from this skill directory (or copy the files from `./resources/`):
```bash
node <path-to-this-skill>/scripts/bootstrap-repo.mjs --target /path/to/target-repo
```
Or manually copy:
- [resources/guardrails.config.ts](./resources/guardrails.config.ts) $\rightarrow$ `<repo>/guardrails.config.ts`
- [resources/run-guardrails.ts](./resources/run-guardrails.ts) $\rightarrow$ `<repo>/scripts/run-guardrails.ts`
- [resources/check-doc-drift.ts](./resources/check-doc-drift.ts) $\rightarrow$ `<repo>/scripts/check-doc-drift.ts`
- [resources/check-complexity.ts](./resources/check-complexity.ts) $\rightarrow$ `<repo>/scripts/check-complexity.ts`
- [resources/dependency-cruiser.cjs](./resources/dependency-cruiser.cjs) $\rightarrow$ `<repo>/.dependency-cruiser.cjs`

### Step 3: Tailor `guardrails.config.ts` & Context Files
1. Edit `guardrails.config.ts` in the target repo to list its actual `scopedModules`, `uiPathPatterns`, and (for brownfield enterprise repos) set `ratchetChangedFilesOnly: true` if you want drift/complexity checks to apply only to files modified in `git status`.
2. Create the root `AGENTS.md` (<35 lines) using [resources/templates/AGENTS.root.md](./resources/templates/AGENTS.root.md).
3. Create a 1-line `CLAUDE.md` containing `@AGENTS.md` and `.github/copilot-instructions.md` pointing to `AGENTS.md` so **Claude Code, GitHub Copilot, and Antigravity** share a single source of truth.
4. Create a concise `AGENTS.md` in each scoped module folder (`src/<module>/AGENTS.md`) listing its `## Purpose`, `## Constraints`, and `## Exported Modules`.
5. Add `package.json` scripts:
   ```json
   {
     "scripts": {
       "check:arch": "depcruise src --config .dependency-cruiser.cjs",
       "check:drift": "node --experimental-strip-types scripts/check-doc-drift.ts",
       "check:complexity": "node --experimental-strip-types scripts/check-complexity.ts",
       "check:visual": "playwright test",
       "guardrails": "node --experimental-strip-types scripts/run-guardrails.ts"
     }
   }
   ```
6. Run `npm run guardrails` and fix any initial drift or boundary issues until green.

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
