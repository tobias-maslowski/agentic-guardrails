# Agent Context Router

> **READ FIRST:** This file is a routing index (<35 lines) designed to prevent context overload. Do **not** read every file in `docs/` or `src/` upfront. Only load the scoped `AGENTS.md` and ADRs relevant to your current task.

## 1. Quick Commands
- **Run All Guardrails (MANDATORY before finishing a task):** `npm run guardrails`
- **Dev Server:** `npm run dev`
- **Build:** `npm run build`

## 2. Progressive Context Routing Table
Before modifying files in a directory, read its scoped `AGENTS.md`:

| Module Path | Responsibility | Scoped Context File | Governing ADRs |
| :--- | :--- | :--- | :--- |
| `src/domain/` | Pure TS domain types, view models, and shared API contracts | `src/domain/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/worker/` | Edge / Server runtime services & environment bindings | `src/worker/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/ui/` | Pure presentation components (Astro / TypeScript) | `src/ui/AGENTS.md` | `docs/adr/0001-layered-modular-boundaries.md` |
| `src/pages/` | Entry routes & `/api/*` endpoints | *(Composition Root)* | `docs/adr/0001-layered-modular-boundaries.md` |
| `public/` | Static assets & runtime workers (e.g. `public/sw.js`) | *(Browser Runtime Assets)* | `docs/adr/0001-layered-modular-boundaries.md` |

## 3. Non-Negotiable Rules
1. **Respect Module Boundaries:** `domain` imports nothing outside `domain`. `ui` and `worker` never import each other—they share contracts via `src/domain/`.
2. **Keep Docs in Sync with Code:** Whenever you add or remove a module file in a scoped directory, list it in that folder's `AGENTS.md` under `## Exported Modules`. `npm run guardrails` will fail if you forget.
3. **Record Architectural Changes:** If you need to change dependency rules or runtime adapters, create or update an ADR in `docs/adr/` first.
