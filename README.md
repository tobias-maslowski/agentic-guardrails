# `agentic-guardrails` — Deterministic AI Coding Guardrails & AST Complexity Advisor

A portable **Agent Skill** and config-driven verification harness for **GitHub Copilot**, **Claude Code**, and **Google Antigravity**.

Designed for modern TypeScript, Astro, Storyblok CMS, and Edge/Cloudflare Worker repositories to solve five failure modes of AI-assisted development:

1. **Context Overload:** Keeps root `AGENTS.md` under 35 lines (~500 tokens) using progressive directory routing (`src/<layer>/AGENTS.md` + `CLAUDE.md` bridge) so agents only read docs relevant to their current task.
2. **Documentation & Schema Drift (`check:drift`):** Deterministically verifies that every module in `src/<layer>/` is documented in its scoped `AGENTS.md`, every ADR path reference exists on disk, every interactive UI control (`<button>` / `<script>`) is covered in Playwright, and (optionally) every Storyblok wrapper calls `storyblokEditable(blok)`.
3. **Architectural Decay (`check:arch`):** Enforces strict module boundaries via `dependency-cruiser` and `.astro` import verification (e.g., `domain` has zero outward imports; `ui` never imports `worker` or raw CMS client internals).
4. **Monolithic AI Code & Template Smells (`check:complexity`):** Uses the TypeScript Compiler AST (`ts.createSourceFile`)—ignoring declarative data arrays and CSS—to advise agents when and where to extract abstraction layers:
   - SonarSource **Cognitive Complexity (`CogC`)** & **Cyclomatic Complexity (`CC`)** per function
   - **Fat Inline Astro `<script>`** detection (keeps `.astro` `<script>` tags as thin DOM glue)
   - **SSR $\leftrightarrow$ Client `.innerHTML` Dual-Render Duplication** detection
   - **SSR Frontmatter Runtime Purity** (prevents importing browser-only globals like `document`, `window`, `navigator`, `HTMLElement` into Edge/Worker SSR frontmatter)
   - **Cross-File AST Statement Clone** detection
   - **Inline Type-Cast Escape** detection (`as any`, `as unknown as`, inline `as { ... }`)
5. **Two-Tier Dependency Hygiene, Security Audit & Freshness (`check:deps`):**
   - **Tier 1 (Local <20ms):** Blocks redundant legacy packages (`axios`, `node-fetch`, `uuid`, `moment`, `crypto-js`, `lodash`) in favor of built-in Web/Worker APIs (`fetch`, `crypto.randomUUID`, `crypto.subtle`, `Intl`) and rejects wildcard `"*"` / `"latest"` versions.
   - **Tier 2 (Diff-Triggered on `package.json` / lockfile changes or `--all`):** Runs `npm audit --json` and `npm outdated --json` to surface known CVEs, remediation paths, and outdated package versions caused by LLM training-cutoff lag.

---

## Requirements

- Node.js **>= 22.6** (scripts run via `node --experimental-strip-types`; the flag is a no-op on Node >= 23.6).
- npm (`check:deps` uses `npm audit` / `npm outdated`; pnpm/yarn are not supported).
- Add `"type": "module"` to the target `package.json` to avoid Node's module-reparse warning on `scripts/*.ts`.
- In an npm workspaces monorepo, bootstrap and run guardrails **per package directory** (`--target packages/web`; run `npm run guardrails` there). Changed-file detection is relative to that directory and also sees the root lockfile (`../package-lock.json`).
- In CI the working tree is clean, so pass the base ref: `npm run guardrails -- --base origin/main` (or `--all`). Without git information every gate runs.
- `check:deps --audit` fails closed: if `npm audit`/`npm outdated` cannot run (offline, no lockfile) the check exits 1.

---

## 1. Install Globally on Your Machine (Claude Code, Antigravity & Copilot CLI)

Clone this repository and run the global symlink installer:

```bash
git clone git@github.com:tobias-maslowski/agentic-guardrails.git
cd agentic-guardrails
chmod +x install-global-skill.sh
./install-global-skill.sh
```

This links the skill into:
- `~/.claude/skills/agentic-guardrails` (**Claude Code**)
- `~/.gemini/config/skills/agentic-guardrails` (**Antigravity**)
- `~/.copilot/skills/agentic-guardrails` (**GitHub Copilot CLI**)

For team-shared repos, you can also vendor or submodule this folder into `.github/skills/agentic-guardrails` or `.claude/skills/agentic-guardrails`.

---

## 2. Bootstrap Any New or Existing Repository

Either ask your coding agent:
> *"Use the `agentic-guardrails` skill to bootstrap guardrails in this repository."*

Or run the bootstrapper CLI directly:

```bash
node /path/to/agentic-guardrails/scripts/bootstrap-repo.mjs --target /path/to/your-project
```

This installs:
- `guardrails.config.ts` — The single project configuration file (scoped module paths, UI trigger regexes, optional Storyblok rules, brownfield `ratchetChangedFilesOnly` mode, and complexity thresholds).
- `scripts/git-changes.ts` — Shared changed-file detection (NUL-safe, untracked dirs expanded, `--base` support).
- `scripts/run-guardrails.ts` — Diff-aware runner (runs static + AST complexity checks in `<300ms`; triggers Playwright `check:visual` automatically only when UI files are modified in `git status`).
- `scripts/check-doc-drift.ts` — Doc-drift, ADR path integrity, `.astro` import boundary, style encapsulation, and interactive selector checker.
- `scripts/check-complexity.ts` — TypeScript & Astro AST Complexity and Architectural Smell Advisor.
- `scripts/check-deps.ts` — Two-tier dependency hygiene, CVE audit and freshness checker.
- `.dependency-cruiser.cjs` — Module boundary rules.
- `package.json` scripts (`check:*`, `guardrails`) — added if missing; existing scripts are never overwritten (a differing one triggers a warning); a minimal `package.json` is created if none exists; `check:types` is added only for Astro projects. You still need `dependency-cruiser` and `typescript` devDependencies (the bootstrapper prints the install command), plus `@playwright/test` if you enable `visualSpecPath` (disabled by default).
- `tsconfig.json` — only its `exclude` list is extended (skipped with a warning for JSONC or `extends`-only configs).
- `AGENTS.md` & `CLAUDE.md` (`@AGENTS.md`) — Progressive context router shared across GitHub Copilot, Claude Code, and Antigravity.

---

## 3. Enterprise / Brownfield "Ratchet Mode"

When adopting in an existing large repository (e.g., an enterprise Storyblok + Astro project), enable Ratchet Mode in `guardrails.config.ts`:

```ts
export const guardrailsConfig: GuardrailsConfig = {
  scopedModules: ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker'],
  storyblok: {
    wrapperDir: 'src/storyblok',
    requireStoryblokEditable: true,
  },
  ratchetChangedFilesOnly: true, // Only flag complexity advisories on files touched in git status
  // ...
};
```

---

## 4. Development

```bash
npm install
npm test   # node:test fixture projects for the bootstrapper and every checker
```

`failOnComplexityAdvisories: true` in `guardrails.config.ts` turns `check:complexity` advisories into a failing gate (default: informational).
