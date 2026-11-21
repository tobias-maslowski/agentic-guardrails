# Agent Context Router (Storyblok + Astro + Edge Worker)

> **READ FIRST:** This file is a routing index (<35 lines) designed to prevent context overload. Do **not** read every file in `docs/` or `src/` upfront. Only load the scoped `AGENTS.md` and ADRs relevant to your current task.

## 1. Quick Commands
- **Run All Guardrails (MANDATORY before finishing a task):** `npm run guardrails`
- **Dev Server:** `npm run dev`
- **Build:** `npm run build`

## 2. Progressive Context Routing Table
Before modifying files in a directory, read its scoped `AGENTS.md`:

| Module Path | Responsibility | Scoped Context File | Governing ADRs |
| :--- | :--- | :--- | :--- |
| `src/domain/` | Pure TS domain view-models, CMS schema types & edge contracts | `src/domain/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/cms/` | Storyblok delivery loader & Blok-to-Domain Anti-Corruption Layer | `src/cms/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/storyblok/` | Thin Storyblok `.astro` wrappers (`storyblokEditable` adapters) | `src/storyblok/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/ui/` | Pure design-system presentation components (zero CMS/Worker imports) | `src/ui/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/worker/` | Cloudflare Worker edge preview detection, caching & PoP bindings | `src/worker/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/pages/` | Astro SSR routes & `/api/*` endpoints | *(Composition Root)* | `docs/adr/0001-layered-modular-boundaries.md` |

## 3. Non-Negotiable Rules
1. **Respect Module Boundaries:** `domain` imports nothing outside `domain`. `ui` never imports `worker`, `cms`, or `storyblok`. `cms` depends only on `domain`.
2. **Keep Docs in Sync with Code:** Whenever you add or remove a module file in a scoped directory, list it in that folder's `AGENTS.md` under `## Exported Modules`. `npm run guardrails` will fail if you forget.
3. **Preserve Storyblok Visual Editor:** Every `.astro` component in `src/storyblok/` must attach `storyblokEditable(blok)`.
