---
id: ADR-0001
title: Strict Layered Module Boundaries & Anti-Corruption Layer
status: accepted
applies_to:
  - src/domain
  - src/ui
  - src/worker
  - src/pages
enforced_by: .dependency-cruiser.cjs
---

# ADR-0001: Strict Layered Module Boundaries

## Context
Coding agents frequently take shortcuts by importing edge runtime logic or raw CMS payloads directly into UI presentation components, or leaking framework/Cloudflare types into core data models.

## Decision
We isolate responsibilities into explicit layers wired together at the route entry layer (`src/pages/`):

1. **`src/domain/`** — Pure TypeScript domain models, view contracts, and schema types. Zero outward dependencies.
2. **`src/cms/`** *(when using Storyblok/CMS)* — Anti-Corruption Layer that fetches stories, parses `_editable` directives, and maps raw CMS bloks into `src/domain/` view models. Depends only on `src/domain/`.
3. **`src/storyblok/`** *(when using Storyblok)* — Thin wrapper components that attach `storyblokEditable(blok)` and delegate rendering to pure `src/ui/` components.
4. **`src/ui/`** — Pure presentation components and client controllers. Depends only on `src/domain/` and `src/ui/`.
5. **`src/worker/`** — Edge runtime services, headers, and environment bindings. Depends only on `src/domain/` and `src/worker/`.
6. **`src/pages/`** — Composition root connecting `worker`, `cms`, `storyblok`, and `ui`.

## Negative Constraints (What Agents Must NOT Do)
- **DO NOT** import anything outside `src/domain/` inside `src/domain/`.
- **DO NOT** import `src/worker/`, `src/cms/`, or `src/storyblok/` inside `src/ui/`.
- **DO NOT** import `src/ui/` or `src/cms/` inside `src/worker/`.
- **DO NOT** import browser-only DOM globals (`document`, `window`, `navigator`, `HTMLElement`) inside modules imported by `.astro` SSR frontmatter (`---`).
