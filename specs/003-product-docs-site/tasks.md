---
description: "Task list for the Product Documentation Site"
---

# Tasks: Product Documentation Site

**Input**: Design documents from `specs/003-product-docs-site/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/routes.md](contracts/routes.md), [contracts/flow-scenarios.md](contracts/flow-scenarios.md), [contracts/theme-tokens.md](contracts/theme-tokens.md), [quickstart.md](quickstart.md)

**Tests**: Included. The success criteria SC-002 to SC-006 and SC-008 are verified by automated checks (research R9). Within each story, tests come after the implementation, and a story is done only when its tests pass.

**Lean process (same as 002)**:
- Tasks are story-sized slices.
- One reviewer pass per story.
- Jira: one Story issue per user story and one Task issue per task, created when work starts. No sub-tasks. Screenshots only on completed stories.
- Tick each task `[X]` right after its commit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**:
  - US1: animated home flow
  - US2: light/dark/system theme
  - US3: migrated docs
  - US4: concept pages
  - US5: section cards

## Path conventions

| Path | Owner agent |
|------|-------------|
| `apps/docs/app/`, `apps/docs/components/`, `apps/docs/lib/`, `apps/docs/*.config.*`, `apps/docs/package.json` | frontend-agent |
| `apps/docs/test/`, `apps/docs/e2e/`, `apps/docs/scripts/` | frontend-automator |
| `apps/docs/content/docs/` | documentator (concepts, guides, admin, operators) / dev-documentator (developers) |
| `.claude/skills/` | skill-writer |
| Repo root, `infra/`, `apps/docs/Dockerfile`, `apps/docs/Caddyfile`, `.github/` | orchestrator |

All commands run in Docker (`docker compose run --rm docs …`). Do not migrate the dev DB or restart unrelated containers.

---

## Phase 1: Setup

**Purpose**: Replace the Starlight app with an empty Fumadocs app that builds as a static export.

- [X] T001 Replace `apps/docs` with a Fumadocs v16 + Next.js 16 app, keeping the package name `docs`:
  - Remove `astro.config.mjs`, `src/content.config.ts`, `tsconfig.json` (Astro) and the Astro dependencies.
  - Move every file from `apps/docs/src/content/docs/<group>/` to `apps/docs/content/docs/<group>/` with `git mv`, unchanged. Delete `src/content/docs/index.mdx`, which is superseded by `/`.
  - Add `apps/docs/package.json` with `next`, `react`, `react-dom`, `fumadocs-core`, `fumadocs-ui` and `fumadocs-mdx` (exact versions, current at 2026-10-11), plus `tailwindcss` v4 and `@tailwindcss/postcss`.
  - Add the scripts `dev` (`next dev -p 4321`), `build` (`next build`), `typecheck` (`tsc --noEmit`), `lint`, `test` (`vitest run`), `test:e2e` (`playwright test`) and `check:links` (`node scripts/check-links.mjs`).
  - Add `next.config.mjs` with `output: 'export'`, `trailingSlash: true`, `images: { unoptimized: true }` and the fumadocs-mdx `createMDX()` wrapper.
  - Add `source.config.ts`, which defines the `docs` collection over `content/docs`.
  - Add `tsconfig.json`, which extends `../../tsconfig.base.json`.
  - Update `pnpm-lock.yaml` with `pnpm install`.
- [X] T002 Add the docs dev service and tooling:
  - `compose.yaml`: a `docs` service running `pnpm --filter docs dev` on `4321:4321`, reusing the existing `node_modules_docs` volume and the install dependency.
  - `.claude/launch.json`: the `docs` entry runs `pnpm --dir apps/docs exec next dev -p 4321`.
  - `.gitignore`: add `apps/docs/.next/`, `apps/docs/out/` and `apps/docs/.source/`.

**Checkpoint**: `docker compose run --rm docs pnpm --filter docs build` produces `apps/docs/out/`.

---

## Phase 2: Foundational (blocks every story)

- [X] T003 Build the layout shell, page routing and search in `apps/docs/`:
  - `lib/source.ts`: `loader({ baseUrl: '/', source: docs.toFumadocsSource() })`.
  - `app/layout.tsx`: `RootProvider` with `search: { options: { type: 'static' } }`, `<html lang="en" suppressHydrationWarning>`, and the site title "ReplyX Docs".
  - `app/[...slug]/page.tsx`: `DocsLayout`, `DocsPage`, `DocsTitle`, `DocsDescription`, `DocsBody`, table of contents and previous/next links, with `generateStaticParams` and `generateMetadata` from the frontmatter `title` and `description`.
  - `app/(home)/layout.tsx`: `HomeLayout`, with `app/(home)/page.tsx` as a placeholder.
  - `app/api/search/route.ts`: `createFromSource(source)`, `export const revalidate = false`, `export const { staticGET: GET }`.
  - `app/not-found.tsx`: a themed 404 page with a link home.
  - `app/global.css`: Tailwind with the `fumadocs-ui` neutral preset and the `fumadocs-ui/css/preset.css` imports.
- [X] T004 [P] Add the ReplyX brand assets:
  - `apps/docs/components/Logo.tsx`: the same path data and `LOGO_COLORS` as `apps/web/src/components/foundations/Logo.tsx`, with a comment telling readers to change both together.
  - Copy `apps/web/public/favicon.svg` to `apps/docs/public/favicon.svg`.
  - In `app/layout.tsx`, set the metadata `icons` and the viewport `themeColor` to `#0D9488`.
  - Self-host the Sora (headings) and Inter (body) woff2 files in `apps/docs/public/fonts/`, loaded with `next/font/local` in `app/layout.tsx`. No external font origin is allowed.
  - Show the logo in the nav title of both layouts through the shared `baseOptions()` in `apps/docs/lib/layout.shared.tsx`.
- [X] T005 [P] Set up the docs test harness in `apps/docs/`:
  - `vitest.config.ts`, which runs `test/**/*.test.ts`.
  - `playwright.config.ts`, which runs `e2e/` against a static server of `out/` on port 4322, started by `webServer: npx serve out -l 4322`. It has `chromium-desktop` and `mobile-360` (360×740) projects.
  - `e2e/fixtures.ts`, which exports an `axe` fixture using `@axe-core/playwright` and fails on `serious` and `critical` issues.
  - Add the dev dependencies `vitest`, `@playwright/test`, `@axe-core/playwright` and `serve`, using the same versions as `apps/web`.

**Checkpoint**: Any content page renders inside the docs layout with search, and the test commands run with zero tests.

---

## Phase 3: User Story 3 — All existing docs in the new site (P1)

**Goal**: All 21 legacy URLs work with unchanged wording and links.

**Independent Test**: Every URL in `contracts/routes.md` returns 200, the link checker passes, and search finds "triage", "SLA" and "complexity".

Phase 3 goes first among the stories because US1's captions link to these pages.

- [X] T006 [US3] Add sidebar ordering:
  - `apps/docs/content/docs/meta.json`: `pages: ["concepts", "guides", "admin", "operators", "developers", "[API reference](https://console.replyx.example.com/api/docs)"]`. Use the existing API docs URL pattern; check `apps/docs/src/content/docs/developers/deployment.md` history for the production path, and keep it an external link only.
  - `meta.json` in each group folder (`guides`, `admin`, `operators`, `developers`), each with a `title` and an explicit `pages` order. Every file must be listed (data-model "Docs Page": "Every file must be listed").
  - Fix any Starlight-only syntax so the files render in Fumadocs without changing the wording. Keep the two ` ```mermaid ` blocks as code blocks (research R11).
- [X] T007 [US3] Add `apps/docs/scripts/check-links.mjs`:
  - Walk `out/**/*.html` and collect `href`s that start with `/` or `#`.
  - Resolve each one to `out/<path>/index.html` or a file, and check that a `#fragment` matches an `id` in the target.
  - Print every broken link with its source file and exit 1 if any are found.
- [X] T008 [US3] Add `apps/docs/test/meta.test.ts`, which checks that every `.md` and `.mdx` file under `content/docs` is listed in its folder's `meta.json`, and that every file has a one-line `title` with no trailing period and a one-line `description`.
- [X] T009 [US3] Add `apps/docs/e2e/legacy-routes.spec.ts`:
  - All 21 URLs from `contracts/routes.md` return 200 and show their `title` as the `h1`.
  - A sidebar item exists for each group (Guides, Admin, Operators, Developers).
  - Search for "triage", "SLA" and "complexity" returns `/guides/triage/`, `/admin/sla-and-business-hours/` and `/guides/ai-assist/` respectively.
  - Then run `check:links` and fix the content until it reports 0 broken links (SC-004).
- [ ] T010 [US3] Update `.claude/skills/docs-style/SKILL.md` (skill-writer) for Fumadocs:
  - Paths are `apps/docs/content/docs/<group>/`.
  - Ordering uses `meta.json` `pages`, so a new page must be added there.
  - The new `concepts/` group is for "how it works" pages that may use the illustration components.
  - The frontmatter rule is unchanged.
  - The API reference is still never hand-authored.
  - Update the "Skill catalog" Purpose cell for docs-style in `CLAUDE.md` from "Starlight" to "Fumadocs".

**Checkpoint**: The docs site is fully usable without the new home page. US3 can ship on its own.

---

## Phase 4: User Story 2 — Light, dark and system themes (P1)

**Goal**: The theme follows the system by default, a manual choice persists, there is no flash, and the palette comes from the design system tokens.

**Independent Test**: Quickstart step 4's theme checks pass, and axe is clean in both themes.

- [ ] T011 [US2] Add the theme tokens and provider config:
  - In `apps/docs/app/global.css`, define every variable from `contracts/theme-tokens.md`: `--rx-*` on `:root` (light) and `.dark` (dark), with the exact values from the table.
  - Map them to Fumadocs: `--color-fd-background`, `--color-fd-card`, `--color-fd-border`, `--color-fd-foreground`, `--color-fd-muted-foreground` and `--color-fd-primary`.
  - Set the heading font to Sora and the body font to Inter.
  - In `app/layout.tsx`, use `RootProvider theme={{ defaultTheme: 'system', enableSystem: true, attribute: 'class' }}`. Confirm the theme switch offers Light, Dark and System.
- [ ] T012 [P] [US2] Add `apps/docs/test/tokens.test.ts`:
  - Parse `app/global.css` and assert that every token in `contracts/theme-tokens.md` exists in both themes.
  - Compute WCAG contrast. Text tokens (`--rx-text`, `--rx-text-2`, `--rx-warning`) must be ≥ 4.5:1 on `--rx-bg` and `--rx-surface`. Stroke and level tokens (`--rx-ai`, `--rx-primary`, `--rx-level-*`) must be ≥ 3:1 on `--rx-bg`.
  - Assert that no file under `components/flow/` or `components/illustrations/` contains a `#[0-9a-fA-F]{3,8}` colour literal.
- [ ] T013 [US2] Add `apps/docs/e2e/theme.spec.ts`:
  - With `colorScheme: 'dark'`, a first visit has `html.dark` at `DOMContentLoaded`. Check the class before hydration with `page.waitForFunction` on the initial HTML; there must be no light flash.
  - Emulating a media change switches the theme live.
  - Choosing Light, reloading, and having the system still dark keeps Light.
  - axe is clean on `/`, `/guides/triage/` and `/developers/authorization/` in both themes.

**Checkpoint**: The theme is correct site-wide, and the illustrations built in later stories inherit it automatically.

---

## Phase 5: User Story 1 — Animated routing and complexity flow on the home page (P1) 🎯 Centrepiece

**Goal**: The hero plays the intake → rules → decision → group/triage → factors → score → level loop. AI elements are neon. It is accessible, and it is static under reduce-motion and with no JS.

**Independent Test**: Quickstart step 4's home checks pass, and the owner watches it for 30 seconds in both themes.

- [ ] T014 [P] [US1] Add `apps/docs/components/flow/complexity.ts`:
  - `export const WEIGHTS = { frustration: 2, severalIssues: 1, technical: 1, vip: 1 }`.
  - `export const THRESHOLDS = { standard: 0.45, advanced: 0.8 }`.
  - `export const ROUTING_CONFIDENCE = 0.7`.
  - `score(factors) = Σ w·v / Σ w`, where each value is in [0,1].
  - `level(score)`: `'Fast'` if score < 0.45, `'Standard'` if score < 0.80, otherwise `'Advanced'`.
  - `route(candidates)`: the top candidate if its confidence ≥ 0.70, otherwise `'Needs Triage'`.
  - Add a comment linking to spec 002 research R12.
- [ ] T015 [P] [US1] Add `apps/docs/components/flow/scenarios.ts`:
  - `STAGES`: the 8 stages from `contracts/flow-scenarios.md`, each with `id`, `caption` (≤ 40 chars), `href` and `ai` (true only for `decision`, `factors`, `score` and `levels`).
  - `SCENARIOS`: the 5 scenarios in loop order, with `message` (≤ 90 chars, made up), `ruleMatch`, `routing.candidates`, `factors` and `expected`, exactly as in the contract table.
- [ ] T016 [US1] Add `apps/docs/test/flow.test.ts`, covering the 5 invariants in `contracts/flow-scenarios.md`:
  1. The expected score and level match `complexity.ts`, rounded to 2 decimal places.
  2. The routing outcome follows the 0.70 rule.
  3. The loop has at least one each of Fast, Standard, Advanced, Needs Triage and a rule match, and Fast + Standard > Advanced.
  4. The hrefs are well-formed internal paths. The link checker covers whether they resolve.
  5. No message contains an email address, a phone number or a capitalised first-name-plus-surname pattern.
- [ ] T017 [US1] Add the artwork, `apps/docs/components/flow/flow-svg.tsx`. It is a server component that renders one original inline `<svg viewBox>` in two layouts: horizontal (≥ 768 px) and vertical (< 768 px), switched with CSS `@container` or a media query on the wrapper.
  - **Nodes**: a rounded rect for each stage, plus three level "pills" and four group chips: Orders & Shipping, Accounts, Technical Support, Billing. Add a Needs Triage node using `--rx-warning`.
  - **Connecting paths**: `<path id>` elements reused by the player for `offset-path`.
  - **`<defs>`**:
    - a `filter id="rx-neon"`: two `feGaussianBlur` passes (stdDeviation 2 and 6), flooded with `--rx-ai-glow` and `--rx-ai-glow-2`, then merged under the SourceGraphic.
    - a linear gradient for AI paths from `--rx-ai` to `--rx-level-advanced`.
  - **Neon scope**: apply `filter="url(#rx-neon)"` and `stroke: var(--rx-ai)` only to the AI stages (`decision`, `factors`, `score`, `levels`) and the paths between them (FR-016a).
  - **Factors**: four gauges (arc or bar), one per factor in `WEIGHTS`, with labels and the weight shown ("×2").
  - **Score**: a dial with tick marks at 0.45 and 0.80.
  - **Colours**: use only `var(--rx-*)`, with no hex values (T012 enforces this). Use a consistent 1.5 px stroke, 12 px radius and Inter labels.
  - **Static state**: the default render is the complete static diagram showing scenario 3 (Technical Support, 0.50, Standard), so no-JS and reduce-motion visitors see a full outcome (research R5).
- [ ] T018 [US1] Add `apps/docs/components/flow/FlowHero.tsx` (server):
  - Wrap the SVG in `<figure role="img" aria-labelledby="flow-desc">`.
  - Add a visually hidden `<p id="flow-desc">` that describes the whole flow in order, including the confidence threshold, the Needs Triage fallback, and the three levels with the cheaper levels used most (FR-011).
  - Lay the 8 stage captions over the SVG as real `<a href>` links, using the `STAGES` captions and hrefs. They need visible `:focus-visible` rings that use `--rx-primary` (FR-007).
  - Add a short heading and subheading above the figure ("Every conversation, routed and answered by the right model").
  - Reserve the size with `aspect-ratio` so there is no layout shift (SC-002).
  - Render it in `app/(home)/page.tsx`.
- [ ] T019 [US1] Add `apps/docs/components/flow/FlowPlayer.tsx` (`'use client'`). It is mounted inside `FlowHero` and is the only client JS for the flow. Target ≤ 15 KB gzip.
  - **Reduce motion**: if `matchMedia('(prefers-reduced-motion: reduce)')` matches, do nothing, and react to changes of that setting (FR-009).
  - **Visibility**: use an `IntersectionObserver` (threshold 0.2) and `document.visibilitychange` to pause and resume every running `Animation`. Do no work while hidden (FR-010).
  - **Sequencer**: for each scenario in `SCENARIOS`, drive the stage state machine from data-model.md (`idle → intake → rules → (decision →) groups|triage → factors → score → level → hold → next`), with roughly the timings in the contract:
    - Move a ticket particle (a small glowing dot plus a message bubble showing `message`) along the matching `<path>` with `offset-path` and the Web Animations API.
    - Highlight the active node.
    - Show the routing candidates with confidence bars, and the chosen group or Needs Triage.
    - Fill the factor gauges to the scenario values with `stroke-dashoffset`.
    - Count up the score with `requestAnimationFrame` (`aria-hidden`).
    - Light up the level pill.
    - On a rule match, show the rule badge and skip the decision node.
  - **Loop**: loop forever. All moving and decorative elements are `aria-hidden`. Use the easing `cubic-bezier(0.2, 0, 0, 1)`.
  - **Theme**: switching theme mid-animation must not restart or flicker. Everything reads CSS variables, so no JS theme handling is needed.
- [ ] T020 [US1] Add `apps/docs/e2e/home-flow.spec.ts`:
  - The figure is visible, and `document.getAnimations().length > 0` within 1 s of load.
  - Over about 40 s, the level pill text cycles through Fast, Standard and Advanced, and the Needs Triage node activates at least once. Speed this up with a `?speed=8` query param read only by FlowPlayer, which multiplies durations by 1/8.
  - When the page is hidden (`page.evaluate` dispatching `visibilitychange` with `document.hidden` stubbed), every animation's `playState` is `paused`.
  - With `reducedMotion: 'reduce'`: there are no running animations, all 8 captions are visible, and scenario 3's outcome is shown.
  - With `javaScriptEnabled: false`: the static diagram, captions and nav are visible.
  - With the `mobile-360` project: `scrollWidth <= clientWidth`, and the vertical layout is visible.
  - Each caption link navigates to its href.
  - axe on `/` is clean in both themes.

**Checkpoint**: The home page centrepiece is done. Get the owner's visual sign-off (SC-007), with screenshots in both themes attached to the Jira story.

---

## Phase 6: User Story 4 — Concept pages with matching illustrations (P2)

**Goal**: "How AI routing works" and "How complexity picks a model" explain the behaviour, with stills in the same visual language as the home page flow.

**Independent Test**: Both pages render, each has at least one illustration and a worked numeric example, they link to the admin and guide pages, and axe is clean in both themes.

- [ ] T021 [P] [US4] Add `apps/docs/components/illustrations/RoutingDiagram.tsx` and `ComplexityDiagram.tsx`:
  - Both are still SVGs that reuse the node shapes, `rx-neon` filter and tokens from `flow-svg.tsx`. Extract the shared primitives (`Node`, `NeonDefs`, `Gauge`, `LevelPill`) into `apps/docs/components/flow/primitives.tsx` and use them from both places.
  - The routing diagram shows: rules first → no match → decision model with group AI descriptions → confidence vs 0.70 → group, or Needs Triage. Manual triage wins.
  - The complexity diagram shows: the 4 default factors with weights → the weighted average → the 0.45 and 0.80 thresholds → the three levels, with Fast as the fallback when complexity is not set up.
  - Both are `role="img"` with a `<title>` and a `<desc>`. Register them as MDX components in `apps/docs/mdx-components.tsx`.
- [ ] T022 [US4] Write `apps/docs/content/docs/concepts/how-ai-routing-works.mdx` and `how-complexity-picks-a-model.mdx` (documentator, docs-style concept rules), plus `concepts/meta.json`.
  - The content must match FR-004 and spec 002:
    - AI routing runs only when no rule matched.
    - It only considers active groups that have an AI description.
    - The default threshold is 0.7.
    - A manual triage choice wins.
    - Factor types: yes/no, scale, choice, customer tag, times reopened (worth 1 at 3 or more), SLA breached.
    - Standard starts at 45% and Advanced at 80%.
    - Fast is used when complexity is not set up or fails.
  - The complexity page has a `## The score` heading, which is the `#the-score` anchor used by the flow.
  - Each page has a worked example that uses scenario 3 or 4 from `contracts/flow-scenarios.md`, with the arithmetic shown.
  - Each page links to `/admin/routing-rules/` or `/guides/ai-assist/` as relevant, and the pages link to each other.
- [ ] T023 [US4] Extend `apps/docs/e2e/legacy-routes.spec.ts` (or add `concepts.spec.ts`):
  - Both concept URLs return 200, and each has a `figure`/`svg[role=img]` and a table or list holding the worked example.
  - axe is clean in both themes.
  - Then run `check:links` again.

---

## Phase 7: User Story 5 — Section cards on the home page (P3)

**Goal**: A benchmark-style card grid below the hero links to each area.

**Independent Test**: Every card links to an existing first page, the cards render in both themes, and there is one column at 360 px.

- [ ] T024 [US5] Add `apps/docs/components/SectionCards.tsx` and render it below `FlowHero` in `app/(home)/page.tsx`. Make 6 cards, each with a small original SVG icon (tokens only), a title, a one-line summary and a link:
  - Agent desk → `/guides/working-tickets/`
  - Customer chat → `/guides/customer-chat/`
  - AI assist → `/guides/ai-assist/`
  - Routing & SLA → `/admin/routing-rules/`
  - Administration → `/admin/organization-settings/`
  - Developers → `/developers/authorization/`

  The whole card is the link, with a visible focus ring and a subtle hover lift. Neon is used only on the AI assist card's icon. The grid is responsive: 3, 2, then 1 columns.
- [ ] T025 [US5] Extend `apps/docs/e2e/home-flow.spec.ts`: there are 6 cards, each link returns 200, there is one column with no horizontal scroll at 360 px, and axe is clean in both themes.

---

## Phase 8: Production serving and polish

- [ ] T026 Add `apps/docs/Dockerfile` and `apps/docs/Caddyfile`:
  - The Dockerfile has a `node:24-slim` build stage with corepack `pnpm@12.5.1`, `pnpm install --frozen-lockfile --filter docs...` and `pnpm --filter docs build`, then a `caddy:2` stage that copies `out/` to `/srv`.
  - The Caddyfile has `:80`, `auto_https off`, `admin off`, and `encode zstd gzip`.
  - Headers are exactly as in `contracts/routes.md`: the CSP with `script-src 'self' 'unsafe-inline'`, HSTS, nosniff, Referrer-Policy, X-Frame-Options and Permissions-Policy, with `-Server`.
  - `/_next/static/*` gets `Cache-Control: public, max-age=31536000, immutable`, and everything else gets `no-cache`.
  - Serve with `try_files {path} {path}/index.html` and `handle_errors` returning `/404.html`.
  - Add a healthcheck.
- [ ] T027 Wire production:
  - `infra/compose.prod.yml`: a `docs` service with build context `..`, `dockerfile: apps/docs/Dockerfile`, `image: replyx-docs:${IMAGE_TAG:-local}`, `restart: unless-stopped`, the shared logging, `no-new-privileges`, `mem_limit: 64m`, `ports: "127.0.0.1:${DOCS_PORT:-8082}:80"`, and a wget healthcheck.
  - `infra/.env.prod.example`: add `DOCS_PORT=8082`.
  - `infra/nginx/replyx.conf`: add an exact-host 443 server block, `server_name replyx.example.com;`, with the same TLS settings, `access_log` and proxy headers, proxying `/` to `127.0.0.1:8082`. Narrow the existing 443 block to `server_name *.replyx.example.com;`. Keep the port 80 redirect block for both. Update the header comment with the diff-before-replace step from quickstart step 6.
  - `infra/scripts/deploy.sh`: after app readiness, wait for `http://127.0.0.1:${DOCS_PORT:-8082}/` in the same way.
- [ ] T028 [P] Update CI, `.github/workflows/ci.yml`: add the docs `typecheck`, `test`, `build` and `check:links` steps, plus `test:e2e` against the static export. Add `apps/docs/Dockerfile` to the image build matrix.
- [ ] T029 [P] Update `apps/docs/content/docs/developers/deployment.md` (dev-documentator): document the `docs` service, the apex nginx block, `DOCS_PORT`, the docs-only CSP and why it differs (from plan Complexity Tracking), and how to roll back.
- [ ] T030 Run all of `quickstart.md` steps 1–5 in Docker and record the results in `specs/003-product-docs-site/run-log.md`. Measure the home page on a Slow 4G profile (LCP ≤ 2.5 s, CLS < 0.05) and check the flow JS size (≤ 15 KB gzip). Give the owner the step 6 deploy commands. Do not run them on the VM.

---

## Dependencies & Execution Order

- Setup (T001–T002) comes first, then Foundational (T003–T005).
- **US3** (T006–T010) comes next, because US1 and US4 link into its pages, and the link checker it adds gates the later stories.
- **US2** (T011–T013) can run in parallel with US3 after Foundational, and must finish before US1's visual work, since the artwork uses its tokens.
- **US1** (T014–T020) depends on US2 tokens. T014 and T015 can start right after Foundational.
- **US4** (T021–T023) depends on US1's T017, which provides the shared primitives.
- **US5** (T024–T025) depends on Foundational and US2 only, and can run alongside US1.
- **Phase 8** (T026–T030) comes after all the stories. T028 and T029 can be done in parallel.

```text
T001 → T002 → T003 ─┬─ T004 ┐
                    └─ T005 ┘
                       ├── US3: T006 → T007 → T008 → T009 → T010
                       ├── US2: T011 → T012 ∥ T013
                       │          └── US1: (T014 ∥ T015) → T016 → T017 → T018 → T019 → T020
                       │                     └── US4: T021 → T022 → T023
                       └── US5: T024 → T025   (after US2)
                                   └── T026 → T027 → (T028 ∥ T029) → T030
```

## Parallel examples

- After T003: T004 (brand assets) ∥ T005 (test harness).
- US1: T014 (`complexity.ts`) ∥ T015 (`scenarios.ts`), then T016.
- Across stories: US3 content work (documentator) ∥ US2 tokens (frontend-agent) ∥ US5 cards.
- Polish: T028 (CI) ∥ T029 (deployment docs).

## Implementation strategy

1. **MVP = Setup + Foundational + US3 + US2.** That is a working Fumadocs site with every page and correct themes. It could replace Starlight on its own.
2. **Centrepiece = US1.** The animated flow. Do the owner's visual review here before moving on, since it is the riskiest part to taste.
3. **Then US4 and US5** for depth and navigation.
4. **Then Phase 8** for production.

For each story: create the Jira Story when it starts and a Task for each task as it starts. Commit each task as `type(scope): Txxx Summary`, using the scope `docs` for `apps/docs` and `infra` for infra. Tick it here right after the commit. One reviewer pass per story.
