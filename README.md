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
- **npm workspaces monorepo (root `package.json` has `workspaces`)**: bootstrap **once at the repository root**. Shared scripts go to `scripts/guardrails/` (one copy), plus a root `guardrails.config.ts` that discovers workspaces (globs such as `apps/*`, `packages/*` are resolved), one root `AGENTS.md` router generated from the real workspace list, one `.github/copilot-instructions.md`, and root scripts `guardrails`, `check:arch`, `check:drift`, `check:complexity`, `check:deps`, `check:imports`, `check:caching` (`check:ssr` when an Astro workspace exists, `check:gate` when a wrangler config exists). Every check iterates over all workspaces. Bootstrapping inside a workspace directory is refused with a pointer to the root (override with `--standalone`). Pass flags through npm with `--`: `npm run guardrails -- --base origin/main`.
- Supported TypeScript: **5.x–6.x**. The checks import the project's `typescript`; an unsupported version (e.g. 7.x beta) fails with one actionable message. The install hint pins `typescript@~5.9` unless a compatible 5.x/6.x is already installed or declared (never downgraded).
- Runner: runs **all** gates and lists every failure at the end (no fail-fast); unknown flags print usage and exit 1. Besides the built-in checks it runs `build`, `check:types`/`typecheck` and `test` when those scripts exist (config `requiredGates` / `optionalGates`). A monorepo with no `test` script anywhere fails unless `requireTests: false`.
- **Scoped `AGENTS.md` under `src/pages`**: never use `AGENTS.md` there (Astro compiles it into the route `/AGENTS`). Use `_AGENTS.md` (underscore files are not routed; `check:drift` accepts it as the scoped file of a `scopedModules` entry) or put the doc in the app root. `check:drift` reports every `.md` file under `src/pages` without a leading `_` (and without a `layout:` frontmatter) as an `Accidental Route`.
- **Interactive selector forms** (`check:drift`, when `visualSpecPath` is set): per interactive `.astro` file, one referenced selector is enough. Accepted forms: `data-*`/`id`/`aria-label` values via `getByTestId('v')`, `[data-testid="v"]`, `[data-testid=v]`, `#v`, `getByLabel('v')` or `{ name: 'v' }`; `class` names via `.v` in a CSS selector literal or the quoted name; `role` values via `getByRole('v')` or `[role=v]`. Dynamic `{...}` values and comments in the spec are ignored.
- **`check:types` generation**: `@astrojs/check` is looked up in the root and every workspace `package.json` (or `node_modules`). With it, the bootstrapper writes `astro check --root <app>` per Astro app and `tsc --noEmit -p <ws>` for workspaces with a tsconfig (single package: `astro check && tsc --noEmit`). Without it, and with an Astro app present, no script is installed (plain `tsc` yields TS2307 on `.astro` imports); the bootstrapper prints `npm install -D @astrojs/check typescript` instead.
- **Protected-site probes**: unauthenticated probes (gate smoke test) use plain `fetch`, never the Playwright `request` fixture, which inherits `extraHTTPHeaders`. The generated CI workflow adds `npx playwright install --with-deps chromium` only when Playwright is declared or `visualSpecPath` is set.
- **Generated files** are normalised (no trailing whitespace, one final newline) so `git add -A && git diff --cached --check` is clean after bootstrapping.
- New config keys: `layersFile`, `skipImportRules`, `skipImportRulesReason`, `plannedPathDirs`, `gate`, `externalRules`, `virtualModules`, `testGlobs`, `fastTierBudgetMs`, `docClaimsAllow`, `allowWeakenedConfig`, `weakenedConfigReason`.
- **Large-repo behaviour**: the fast tier runs its checks concurrently (4 at a time) and prints results in order; `check:arch` runs dependency-cruiser per workspace in parallel, only for workspaces with in-scope files when diff-scoped, ignores type-only imports for cycles (`tsPreCompilationDeps: false`) and prints one summary line. A failing check prints at most ~40 lines (`--verbose` for all); with `--all` the full output is also written to `.guardrails-cache/report.txt`.
- **`check:imports` aliases and grouping**: `resolve.alias` / `vite.resolve.alias` in `astro|vite.config.*` (static object or array literals), tsconfig/jsconfig `compilerOptions.paths`, `#subpath` imports and `virtualModules` (globs like `project/*`) are never "undeclared". Each undeclared package is reported once per workspace with a count and the first 3 locations. Only static literal aliases are read; computed aliases need `virtualModules`.
- **`layersFile`**: point the config at an existing layers file (`scripts/module-layers.json`) instead of copying layers. Shapes: `{ layers: [{ name, workspaces|members|packages, devOnly? }] }`, `{ layers: [[...]] }`, or an object `name -> [...]` (low to high); members are names, dirs, globs or bare dir names. A `devOnly` tier (mocks, tooling) is an ordinary layer by position and may additionally only be depended on through devDependencies/peerDependencies. An unknown shape fails with the accepted shapes. `skipImportRules: ['layers'|'exports'|'declared']` plus `skipImportRulesReason` skips rules an existing test already enforces (reported as weakened without a reason).
- **Doc drift refinements**: backticked paths are resolved against the repo root, the doc's directory and every workspace root and `src/` (`lib/foo.ts` in `apps/AGENTS.md` matches `apps/*/src/lib/foo.ts`); gitignored (`git check-ignore`) and secret-like paths (`.env*`, `.dev.vars`, `*.pem`) are not dead paths; docs under `plannedPathDirs` (default `docs/migration`, `docs/plan*`, `docs/adr`) are skipped for dead-path claims; a routes table needs a Routes/Pages/Endpoints heading and cells starting with `/`; placeholders match `replace me` only as a standalone phrase; an `npm run x` is accepted when any workspace has the script; `visualSpecPath` may be a file, a glob or an array; script-only `.astro` files without selectors need no spec selectors.
- **`check:deps` policy**: `dependencies.outdatedPolicy` is `'major'` (default: only major gaps fail), `'minor'` or `'any'`; smaller gaps are one count line.
- **`check:gate`** never reads `dist/` or `.wrangler/` (so results do not change after a build). A gate is recognised by config `gate: { function, from }`, by a call to an imported function matching `/gate|access|guard/i` in a middleware/worker entry, or by a literal 4xx Response.
- **Complexity** excludes test files (`testGlobs`) and prints the top 5 advisories plus one summary line.
- **Runner wiring**: `test` and `check:visual` are wired from the root only when a root script exists; workspace `test:unit` scripts and a `playwright.config.*` in any workspace are discovered and run with `--all`; an existing root `check`/`typecheck` script is reused as the type gate instead of generating a second chain.
- **Adopt mode**: the bootstrapper detects existing enforcement (a layers file, `scripts/guard*`, doc-claims/boundary tests, a `verify` script, `.husky`, a non-GitHub CI) and never edits or duplicates it: it reads the layers file via `layersFile`, skips ADR-0001 when `docs/adr` or `docs/decisions` already has records, generates no GitHub workflow for Jenkins/GitLab/Azure/Bitbucket/CircleCI (it prints the command to add), and prints the husky line instead of editing hooks. It ends with an "Installed / skipped" table. `--adopt` additionally skips the `check:imports` rules that existing guard scripts overlap (config `skipImportRules` with a reason); `--patch-agents` appends one `npm run guardrails` line to an existing AGENTS.md (idempotent); `--scaffold-specs` writes the starter `tests/interactive.spec.ts` (never by default). An existing Playwright config with specs anywhere in the monorepo (e.g. `packages/qa`) is wired as `visualSpecPath` (a glob) instead of scaffolding.
- **Defaults are strict, with one exception**: interactive `.astro` files without any spec leave `visualSpecPath` null, which the runner reports as a weakened-config failure until a spec is wired (the bootstrapper prints that next step).
- Changed-file detection is relative to the bootstrapped directory and also sees the lockfile at the repository root.
- In CI the working tree is clean, so pass the base ref: `npm run guardrails -- --base origin/main` (or `--all`; `CI=true` also enables the slow tier). Without git information every gate runs.
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
- `scripts/run-guardrails.ts` — Diff-aware runner (fast tier always, slow tier (build, types, tests, Playwright, deps audit) only with `--all` or `CI=true`; diff-aware scope, quiet output, timing).
- `scripts/check-doc-drift.ts` — Doc-drift, ADR path integrity, `.astro` import boundary, style encapsulation, and interactive selector checker.
- `scripts/check-complexity.ts` — TypeScript & Astro AST Complexity and Architectural Smell Advisor.
- `scripts/check-deps.ts` — Two-tier dependency hygiene, CVE audit and freshness checker.
- `.dependency-cruiser.cjs` — In-package module boundary rules. `check:arch` fails if depcruise is missing, cannot transpile TypeScript, or cruises 0 modules in a workspace that has cruisable sources (`.ts/.tsx/.js/.mjs/.cjs`). A workspace whose `src` holds only `.astro` files is reported as `skipped: N .astro files are covered by check:imports`.
- `scripts/check-imports.ts` — Workspace boundaries (monorepo): relative imports escaping a workspace, undeclared workspace deps, subpath imports vs the target `exports` map (wildcards, conditions; no `exports` = main entry only), `layers` (`string[][]` or `{ name, workspaces }[]`, low→high; only strictly lower layers; unlisted workspaces are errors), dependency cycles, 0-files-scanned. Covers `.ts/.tsx/.js/.mjs/.astro` (frontmatter and `<script>`), dynamic `import()` and re-exports; reports `file:line` and the fix.
- `scripts/check-ssr.ts` — Astro pages reading `Astro.cookies`, `Astro.request.headers`, `Astro.locals`, `Astro.url.searchParams` must be server-rendered (`output: 'server'` or `prerender = false`); `prerender = true` with request data is an error.
- Doc drift also verifies AGENTS.md routing paths/links, quoted `npm run` commands against the right `package.json`, leftover placeholders, ADR files, relative links, and (when `visualSpecPath` is null) prints that selector sync was SKIPPED and flags interactive components, and, once `visualSpecPath` is set, selector-checks every `.astro` file with `<button>`/`<script>`/`client:*` under any workspace's `src` (`<script>`/`client:*`) without specs (`requireInteractiveSpecs`).
- Complexity includes cross-file clone detection of normalized function bodies (≥6 statements or ≥60 tokens) as advisories (`failOnComplexityAdvisories` makes them fail).
- `check:deps` in a monorepo merges identical findings across workspaces into one line prefixed with every declaring workspace (`[apps/web, packages/ui] ...`). It never flags or queries workspace-internal deps (`*`, `workspace:*`, local names); `--audit` has a timeout (`dependencies.auditTimeoutMs`, default 30000) and fails closed with a one-line error.
- `package.json` scripts (`check:*`, `guardrails`) — added if missing; existing scripts are never overwritten (a differing one triggers a warning); a minimal `package.json` is created if none exists; `check:types` is added only when a tsconfig exists and it can run (`astro check` needs `@astrojs/check`, otherwise `tsc --noEmit`); dead scripts are never installed. You still need `dependency-cruiser` and `typescript` devDependencies (the bootstrapper prints the install command), plus `@playwright/test` if you enable `visualSpecPath` (disabled by default).
- `tsconfig.json` — only its `exclude` list is extended (skipped with a warning for JSONC or `extends`-only configs).
- `AGENTS.md` & `CLAUDE.md` (`@AGENTS.md`) — Progressive context router shared across GitHub Copilot, Claude Code, and Antigravity.

### Additional checks and config keys
- **`check:caching`** (`scripts/check-caching.ts`, deterministic heuristic, `file:line` + fix): a route (`src/pages` page or endpoint) or middleware that really reads request cookies, `Astro.session`, `locals.session|user|member|auth` or the `cookie`/`authorization` request header (also through its import chain) must set `Cache-Control` with `no-store` or `private` in the route, a layout/helper in its import chain, a `src/middleware` file, or the `/*` block of `public/_headers`. Opt out per route with `// guardrails-allow: caching <reason>` (the reason is required). Detection is AST based (`cache-headers.ts`): a header write counts (`headers.set/append('Cache-Control', …)`, `setHeader`, `new Headers({…})`, a `Response` init `headers`, `Astro.response.headers.set`, a `['Cache-Control', v]` pair); a literal in a comment or an unrelated string does not. A write inside a conditional branch (`if`, `?:`, `&&`, `switch`, `catch`) counts only when the cookie/session read is in the same branch. A middleware or worker entry (`src/worker*`, `src/entry*`, `src/index`) that sets the header unconditionally (e.g. on the response of `next()` or `env.ASSETS.fetch`) covers every route. Still a heuristic: it does not follow calls. Required gate in monorepo mode; run when the script exists in single-package mode.
- **`check:ssr`** also analyses `.ts/.js` endpoints under `src/pages` and follows imports transitively (components, layouts, lib helpers) from a prerendered page to request-data reads (`Astro.cookies/request/locals/url.searchParams`, `context.cookies`, `request.headers`, `cookies.get`); output names the page `file:line` and the reaching `file:line`. Reachability follows imports, not calls.
- **`check:imports`** also reports imports of external npm packages not declared in the importing workspace's `package.json` (ignores `node:` builtins, `cloudflare:*`, `astro:*`, `@types/*`, config `virtualModules`), and applies `externalRules: [{ workspaces, forbid, allowOnly? }]` (globs like `node:*`, `@storyblok/*`). The bootstrapper generates a default rule only for workspaces named `domain`, `core`, `shared-types`, `types` or `utils`, forbidding `node:*`, `cloudflare:*`, `astro:*`. Nothing is forbidden for layers or UI/CMS packages, and `@storyblok/*` is only a commented example in the config.
- **`check:arch`** (dependency-cruiser): layer rules are generated only for `src/<layer>/` folders that exist, match at any depth (`(^|/)src/domain/`), and the output states modules cruised, `.astro` files not cruised and which rules were active.
- **Doc drift**: backticked paths and markdown links in ALL markdown (README, AGENTS, `docs/**`, workspace READMEs; fenced code, URLs, globs, `<placeholders>` skipped; `docClaimsAllow` globs exempt) must exist; `/route` claims under a Routes/Pages/Endpoints heading or table are matched against file-based routes under `src/pages` (`index`, `[param]`, `[...rest]`, `.ts` endpoints).
- **`check:deps` (monorepo)** evaluates outdated per unique direct package with `npm view <pkg> dist-tags.latest` (bounded by `dependencies.auditTimeoutMs`), skipping local workspaces and deduping. A TypeScript `latest` whose major is above the supported range is informational ("latest major not yet supported by the guardrail checks, pinned to supported range") and does not fail.
- **Weakened config**: the runner compares the effective `guardrails.config.ts` with `resources/defaults.ts` (single source of truth) and prints each deviation under `Disabled or weakened checks`: empty `scopedModules`/null `globalLayoutAstroPath` (single-package), `visualSpecPath: null` or `requireInteractiveSpecs: false` with interactive files, `requireTests: false`, empty `externalRules`, `failOnOutdated: false`, severity `'none'`, non-empty `acknowledgedAdvisories`, empty `uiTriggerPatterns` with a visual spec, `requiredGates`/`optionalGates` narrowed below the defaults, `importScanIgnoreDirs` containing `src` or a workspace dir, a catch-all `docClaimsAllow` (`*`, `**`), `thresholds` raised above the defaults (lowering is fine), `externalRules` that leave a `domain|core|shared-types|types|utils` workspace without `node:*`/`cloudflare:*`/`astro:*`, `requireAdr: false`, `storyblok.requireStoryblokEditable: false`, `ratchetChangedFilesOnly: true`, a single `layers` entry, `uiTriggerPatterns` matching none of the interactive files, a gate script (`check:*`, `guardrails`, `build`, `check:types`, `typecheck`) that is a no-op or no longer runs its shipped `scripts/guardrails/<check>.ts`, or is missing although its trigger exists (workspaces → `check:imports`, `.astro` files → `check:ssr`/`check:caching`; the runner still runs the shipped script directly and prints one line saying so), `testGlobs` matching source files broadly, and a `test` script that is a no-op (`true`, `:`, `exit 0`, `echo ...`) or has no known runner and no `*.test.*`/`*.spec.*` file. It exits 1 unless `allowWeakenedConfig: true` and a non-empty `weakenedConfigReason` are set (the reason is printed). Bootstrap defaults are strict except one case: a repo with interactive `.astro` files (`<script>`/`client:*`) and no Playwright spec starts with `visualSpecPath: null`, which the runner reports as weakened until a spec exists. The bootstrapper prints that next step, and when Playwright is already declared/configured and `tests/` has no spec it scaffolds `tests/interactive.spec.ts` (`test.fixme` skeleton) and wires `visualSpecPath`; `check:drift` then lists the selectors the spec does not cover.
- **Playwright is diff-aware, not always-on**: `check:visual` is a slow-tier gate run as `playwright test --reporter=line`; the runner parses the result and FAILS on 0 tests, all skipped or `No tests found`, prints `N passed, M skipped`, and trims failure output (browser-install banners dropped, ~25 lines unless `--verbose`). It runs only with `--all`/`CI=true`, only when `visualSpecPath` is set, and (without `--all`) when a changed file matches `uiTriggerPatterns` (defaults include any `src` file matching `session|auth|cookie|middleware|mapper`) or is an interactive `.astro` file; otherwise the runner prints `skipped (no changed files match triggers); use --all or CI`.
- **Tiers**: fast tier (always): `check:imports`, `check:ssr`, `check:caching`, `check:gate`, `check:drift`, `check:arch`, `check:complexity`, and `check:deps` offline (banned/unpinned, no network). Slow tier (only with `--all` or `CI=true`): `build`, `check:types`/`typecheck`, `test`, `check:visual`, `check:deps --audit` (network). Fast-tier checks run concurrently. Locally, a run prints one line `Skipped slow tier (...)` naming what was skipped; when `package.json`/lockfile/config changed, deps still run offline. CI should run `npm run guardrails -- --all`.
- **Runner output and flags**: one line per passing check with elapsed ms, details only on failure (max 20 findings per check, `+N more (use --verbose)`), advisories only as a count unless `--verbose`/`-v`; per-check timing and a total, with a warning above config `fastTierBudgetMs` (default 10000). `--no-cache` disables the result cache.
- **Diff-aware scope**: `check:imports`, `check:ssr` and `check:caching` scan changed files plus their transitive importers (scope file `.guardrails-cache/scope.json`, env `GUARDRAILS_SCOPE_FILE`). A full scan runs with `--all`, in CI, on a clean tree without `--base`, when `package.json`, a lockfile, a tsconfig, `guardrails.config.ts`, `astro.config.*`, the dependency-cruiser config or an installed guardrail script changed, or when a source file was deleted/renamed. `check:arch`, `check:drift`, `check:complexity` (has its own ratchet via `ratchetChangedFilesOnly`) and `check:deps` stay full scans: their result depends on the whole tree/manifest.
- **Result cache**: fast-gate passes are cached in `.guardrails-cache/` (added to `.gitignore` by the bootstrapper), keyed by a whole-tree stat hash (path, size, mtime) + gate + scope + base. Coarse but safe: any change in the tree invalidates it. Not used in slow mode.
- **`testGlobs`** (default `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`): test files are exempt from `externalRules` and the undeclared-package check, so a pure package may co-locate `node:test` suites.
- **Doc-drift path rule**: only backticked tokens that look like repo paths are checked (a directory separator, a known extension or a trailing slash AND a first segment that is an existing top-level/workspace dir, or a `./`/`../` prefix). Bare filenames such as `index.astro` are never checked. `Path=/`, HTTP paths and other prose are ignored. Route claims are checked only under a Routes/Pages/Endpoints heading or table, never in free prose (false-positive risk).
- **`check:gate`** (static, installed and wired only when a wrangler config exists): a site-wide access gate (middleware/worker entry returning `new Response(…, { status: 4xx })` after a secret/key compare; config `gate: { file?, status? }` overrides the detection) on a Workers deployment with static `assets` requires `assets.run_worker_first` (true or a pattern list) in EVERY `wrangler*.json|jsonc|toml` of the app and in a generated `dist/server/wrangler.json`, or a custom `main` that wraps `env.ASSETS.fetch`; otherwise static assets and `/` bypass the gate. `requireGate` (default true in monorepo mode when a wrangler config with assets and a middleware/worker entry exist) fails when no gate is detected. A detected gate without a gate-smoke spec (referencing `dist/` or `dist/server/wrangler.json` and a real asset path such as `/_astro/…`, `.svg`, `.js`, `.css`) is an advisory. The runner runs `check:gate` whenever a wrangler config with `assets` exists, even if the script was never bootstrapped, and says so in one line. It cannot prove runtime behaviour: add a smoke test against the built worker (`resources/templates/playwright.protected.gate-smoke.spec.ts` asserts unkeyed 404 on `/` and on a real built asset, and keyed 200 on that asset, so a missing asset cannot fake a pass).
- **Protected-site Playwright variant** (`resources/templates/playwright.protected.config.ts` + `playwright.protected.global-setup.ts`): for a site that answers 404 without a key, readiness is a TCP `port` check on `webServer` plus an authenticated request in `globalSetup` (`PLAYWRIGHT_AUTH_COOKIE="name=value"`, or `PLAYWRIGHT_AUTH_HEADER` + `PLAYWRIGHT_AUTH_VALUE`, also sent as `extraHTTPHeaders`); it fails clearly on 401/403/404. Run `npx playwright test -c playwright.protected.config.ts`.
- **CI and hooks**: the bootstrapper writes `.github/workflows/guardrails.yml` (`npm ci`, a `npx playwright install --with-deps chromium` step only when Playwright is declared or a visual spec is set, `npm run guardrails -- --all`) unless another workflow already runs guardrails; a rerun adds the Playwright step to a pristine generated file and only prints a hint for one you modified. `--hooks` (opt-in) writes `.githooks/pre-push` running the fast tier; enable per clone with `git config core.hooksPath .githooks` (nothing is set globally). `--force` saves the previous config as `guardrails.config.ts.bak` and never resets an existing `visualSpecPath`; with `dependency-cruiser` already installed the `Next:` line no longer mentions it. Files in `scopedModules` named `*.test.*`/`*.spec.*` need no Exported Modules entry. When `package-lock.json` changed locally, the offline dependency checks run and one line reminds you to run `--all` for the network audit (there is no extra offline audit).
- **Type-checking `.astro`**: the runner prints an advisory with the fix when `.astro` files exist and no script runs `astro check`; with `@astrojs/check` declared or installed, the monorepo bootstrap adds a root `check:types` running `astro check --root <ws>` for Astro workspaces and `tsc --noEmit -p <ws>` for the other workspaces with a tsconfig.
- New config keys: `externalRules`, `virtualModules`, `testGlobs`, `fastTierBudgetMs`, `docClaimsAllow`, `allowWeakenedConfig`, `weakenedConfigReason`.

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
