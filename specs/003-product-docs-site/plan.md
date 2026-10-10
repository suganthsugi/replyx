# Implementation Plan: Product Documentation Site

**Branch**: `003-product-docs-site` (spec directory; work happens on `main`) | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-product-docs-site/spec.md`

## Summary

Replace the Starlight site in `apps/docs` with a Fumadocs site, built with Next.js and exported as static HTML. Every one of the 21 existing pages keeps its current URL (`/guides/triage/` and so on), so internal links and old addresses keep working without rewrites. The home page at `/` is a custom landing page. Its hero is an original, hand-built inline SVG of the AI flow:

intake → rules → decision model → group or Needs Triage → complexity factors → score → Fast / Standard / Advanced

A small client controller plays this as a looping sequence of five fictional scenarios. The scores in those scenarios are computed with the real 002 formula, a weighted average with thresholds 0.45 and 0.8. All colours come from CSS variables that switch with the theme. AI elements get a neon glow filter built from the brand teal.

Reduce-motion and no-JS visitors get the full static diagram. In production a separate small Caddy container serves the export. The host nginx sends the bare domain `replyx.example.com` to that container and keeps sending `*.replyx.example.com` to the app, as today.

## Technical Context

**Language/Version**: TypeScript 5.9, Node 24 (`.nvmrc` v24.18.0), React 19

**Primary Dependencies**:
- Fumadocs v16: `fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx`
- Next.js 16 with the App Router and `output: 'export'`
- Tailwind CSS v4, which Fumadocs UI requires
- `next-themes`, used through Fumadocs `RootProvider`
- No animation library. The animation uses SVG, CSS, and the Web Animations API (research R4).

**Storage**: None. Content is MDX/Markdown files in the repo.

**Testing**:
- Vitest: scenario math and the integrity of the flow data.
- Playwright with `@axe-core/playwright`: home page, theme, reduce-motion, no-JS, mobile, and an axe check of every route in both themes.
- A build-time link checker over the export (research R9).

**Target Platform**: Static files served by Caddy behind the host nginx on the owner's Ubuntu 24.04 VM. Evergreen browsers.

**Project Type**: Static documentation website. This is a workspace app in the pnpm/turbo monorepo.

**Performance Goals**:
- Hero visible within 2.5 s on Slow 4G (LCP ≤ 2.5 s).
- CLS < 0.05.
- The animation runs at 60 fps on a mid-range laptop and phone, with zero animation work while hidden.
- Home page JS for the flow is ≤ 15 KB gzipped on top of the framework.

**Constraints**:
- WCAG 2.2 AA in both themes.
- Works with `prefers-reduced-motion` and with JS disabled.
- No external origins: fonts and scripts are self-hosted.
- The docs host gets its own CSP (research R6).
- Tenant, console and customer hosts are unchanged.

**Scale/Scope**:
- 21 migrated pages and 2 new concept pages.
- 1 animated hero with 5 scenarios.
- About 6 still illustrations and 6 section cards.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Applies? | Status |
|---|---|---|
| I Tenant isolation | No tenant data. The site is static, on the apex host only. Tenant hosts still route to the app. | Pass |
| II One authorization path | No auth. The site is public. | N/A |
| III Modules plug in | The docs app is separate from the API and has no shared infrastructure changes. | Pass |
| IV DB is source of truth | No state. | N/A |
| V Event-driven side effects | None. | N/A |
| VI Security by default | Strict headers. CSP is scoped to the docs host. There are no forms, no user input, no cookies, and no third-party origins. App cookies are host-only, so the apex cannot read tenant sessions (verified: no cookie `domain` is set in `apps/api/src`). See Complexity Tracking for `'unsafe-inline'`. | Pass, with a recorded deviation |
| VII Tests guard critical paths | No critical product path is touched. The docs get e2e, axe and link-check gates anyway. | Pass |
| VIII Simple over clever | Static export plus a plain Caddy container, the same tech already in prod. No animation or diagram library. | Pass. The new container is recorded in research R7. |
| IX Clean contracts | No API changes. | N/A |
| X Observable | Caddy access logs go to the existing log driver. No PII. | Pass |
| XI Original, consistent UX | Original illustrations. The palette and logo come from the current design system tokens (teal/slate, Sora/Inter). Customers never see ticket concepts in the product, and the docs are not the customer UI. The flow illustrates staff-side AI behaviour, as the current `guides/ai-assist.md` already does. | Pass |

**Post-design re-check (after Phase 1)**: still passes. The only deviation is the docs-host CSP `script-src 'unsafe-inline'`, recorded below and in research R6.

## Project Structure

### Documentation (this feature)

```text
specs/003-product-docs-site/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── routes.md            # URL map, redirects, headers per host
│   ├── flow-scenarios.md    # Flow stage and scenario data contract and invariants
│   └── theme-tokens.md      # CSS variables the illustrations may use
└── tasks.md                 # /speckit-tasks
```

### Source Code (repository root)

```text
apps/docs/                              # replaced in place: Astro/Starlight → Next.js/Fumadocs
├── package.json                        # next, fumadocs-*, tailwindcss; scripts dev/build/test/test:e2e
├── next.config.mjs                     # output: 'export', trailingSlash: true, images.unoptimized
├── source.config.ts                    # fumadocs-mdx collection: content/docs
├── Dockerfile                          # build stage (pnpm --filter docs build) → caddy:2 serving out/
├── Caddyfile                           # static file server + docs CSP/security headers
├── content/docs/
│   ├── meta.json                       # root order: concepts, guides, admin, operators, developers
│   ├── concepts/                       # NEW: how-ai-routing-works.mdx, how-complexity-picks-a-model.mdx
│   ├── guides/  admin/  operators/  developers/   # moved .md files, unchanged wording, + meta.json each
├── app/
│   ├── layout.tsx                      # RootProvider (theme: system default), self-hosted fonts
│   ├── global.css                      # Tailwind + fumadocs preset + ReplyX token CSS variables
│   ├── (home)/page.tsx                 # landing: hero flow, captions, section cards
│   ├── [...slug]/page.tsx              # DocsLayout + DocsPage; generateStaticParams
│   ├── api/search/route.ts             # Orama static index (staticGET)
│   └── not-found.tsx
├── components/
│   ├── flow/
│   │   ├── FlowHero.tsx                # server: renders the SVG + text alternative + captions
│   │   ├── flow-svg.tsx                # the artwork (nodes, paths, defs: neon filter, gradients)
│   │   ├── FlowPlayer.tsx              # client: sequencer, IntersectionObserver, visibility, reduce-motion
│   │   ├── scenarios.ts                # the 5 scenarios + stage list (contract: flow-scenarios.md)
│   │   └── complexity.ts               # score + level functions (mirror of 002 formula)
│   ├── illustrations/                  # still SVG components for concept pages (routing, complexity)
│   ├── SectionCards.tsx
│   └── Logo.tsx                        # same path data as apps/web Logo
├── lib/source.ts                       # loader({ baseUrl: '/' })
├── public/                             # favicon.svg (copy of apps/web), fonts/
├── scripts/check-links.mjs             # crawls out/ for broken internal links and anchors
├── test/                               # vitest: complexity.test.ts, scenarios.test.ts
└── e2e/                                # playwright: home, theme, a11y, nav, search, no-js

infra/
├── compose.prod.yml                    # + docs service (127.0.0.1:${DOCS_PORT:-8082})
├── nginx/replyx.conf        # + exact-host server block for replyx.example.com → 8082
└── scripts/deploy.sh                   # + wait for docs readiness
compose.yaml                            # + docs dev service (next dev on 4321)
.claude/launch.json                     # docs entry → next dev
.claude/skills/docs-style/SKILL.md      # updated for Fumadocs paths, meta.json, MDX components
.github/workflows/ci.yml                # + docs build, unit, link check
```

**Structure Decision**: Replace `apps/docs` in place, keeping the package name `docs` so turbo, CI and the compose volume `node_modules_docs` keep working. Content moves from `src/content/docs/<group>/` to `content/docs/<group>/` with the same file names, so the slugs, and therefore the URLs, stay the same.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Docs-host CSP allows `script-src 'self' 'unsafe-inline'` (the app hosts keep `'self'` only) | A Next.js static export writes inline `<script>` tags for the RSC payload and the theme script on every page, and `next-themes` needs an inline script before paint to avoid a theme flash (FR-014) | Per-page hashes in a `<meta>` CSP: a post-build rewrite of every HTML file that breaks silently when Next changes its output. Self-hosted scripts only: not possible with Next export. Risk is low: the host has no cookies, sessions, forms or user content, and tenant cookies are host-only. |
| One extra prod container (`docs`, Caddy) | Gives the docs their own CSP and release cycle without touching the app's Caddy image | Folding the docs into the `caddy` image couples the app and docs builds and makes host-based CSP branching harder. Having nginx serve files from disk does not fit the image-based deploy in `deploy.sh`. |
