# Research: Product Documentation Site

All Technical Context unknowns are resolved below. Sources: fumadocs.dev (static build guide, v16 release notes, npm `fumadocs-ui` 16.15.x as of 2026-10-11), the repo (`apps/docs`, `apps/web/src/theme/tokens.ts`, `infra/*`), and spec 002 (`research.md` R12).

## R1 Framework flavour for Fumadocs

- **Decision**: Fumadocs v16 on **Next.js 16 (App Router)** with `output: 'export'`, `trailingSlash: true`, and `images.unoptimized: true`.
- **Rationale**: Next.js is Fumadocs' primary, best-documented target. Static export gives plain files that Caddy can serve, with no Node server in prod. `trailingSlash: true` matches the Starlight URLs (`/guides/triage/`) and writes `index.html` per folder.
- **Alternatives considered**: React Router SPA prerender or TanStack Start. Both use Vite, like `apps/web`, but they are younger Fumadocs targets and have fewer examples. Their prerender output also has inline scripts, so they would not avoid R6. Waku was rejected as too new.

## R2 Keeping URLs (FR-003)

- **Decision**: Mount docs at the root with `loader({ baseUrl: '/' })` and the route `app/[...slug]/page.tsx`. Put the landing page at `app/(home)/page.tsx`. Files keep their names and folders, so every old URL resolves unchanged and no redirect table is needed.
- **Rationale**: All 30-plus internal links are absolute with a trailing slash (`/admin/roles-and-groups/`), so they stay valid as written. FR-003 is met by identity.
- **Guard**: the link checker (R9) fails the build on any broken internal link or anchor. A Playwright test loads all 21 legacy paths from `contracts/routes.md`.
- **Alternatives**: The `/docs/...` prefix that Fumadocs uses by default. That would need 21 redirects and changes to every internal link.

## R3 Sidebar groups and order

- **Decision**: Use `meta.json` per folder. The root order is `concepts`, `guides`, `admin`, `operators`, `developers`. The "API reference" external link stays as a root `meta.json` link entry, pointing to `/api/docs` on the console host. It stays an external link and is never hand-authored.
- **Rationale**: This is the Fumadocs-native equivalent of the Starlight `autogenerate`. Explicit ordering replaces alphabetical order.

## R4 Animation technique

- **Decision**: Inline SVG, rendered on the server, plus one small client controller (`FlowPlayer`). The controller uses the **Web Animations API**:
  - It moves "ticket" particles along SVG paths with CSS `offset-path: path(...)`, which matches the drawn `<path d>`.
  - It fills factor gauges by animating `stroke-dashoffset`.
  - It counts up the score with a `requestAnimationFrame` text update, which is `aria-hidden`.
  - It highlights the chosen node with class toggles.

  One timeline per scenario is chained in a loop.
- **Rationale**: There is no dependency, so the JS stays tiny. WAAPI animations can be paused and resumed (`animation.pause()`) for FR-010. Transforms and opacity run on the compositor, which keeps 60 fps. `offset-path` is supported in all evergreen browsers.
- **Alternatives**:
  - SMIL `<animateMotion>`: hard to sequence and pause per scenario, and it ignores reduce-motion.
  - Framer Motion or GSAP: 20–60 KB for what WAAPI already does.
  - Lottie: needs After Effects authoring, and its colours cannot follow theme variables.
  - Canvas: no DOM text, so accessibility and theme handling get harder.

## R5 Reduce motion, no JS, visibility

- **Decision**:
  - The server-rendered SVG is the **complete static diagram** (all stages, captions, one example outcome drawn). JS only adds motion, so no-JS visitors and reduce-motion visitors see the same complete picture.
  - `FlowPlayer` checks `matchMedia('(prefers-reduced-motion: reduce)')` and listens for changes. It does not start when that is set.
  - It uses an `IntersectionObserver` with threshold 0.2 and the `visibilitychange` event to call pause and resume.
  - It reserves the hero size with `aspect-ratio` so there is no CLS.
- **Text alternative**: the SVG is wrapped as `<figure>` with `role="img"` and `aria-labelledby`, pointing to a visually hidden `<p>` that describes the whole flow in order (FR-011). The moving particles and the counting score are `aria-hidden`. The captions are real `<a>` links outside the SVG graphics, laid over it, so they get keyboard focus and visible focus rings.

## R6 Theme and CSP

- **Decision**:
  - Use Fumadocs `RootProvider` with `theme={{ defaultTheme: 'system', enableSystem: true }}`. That is `next-themes`, which writes the `class="dark"` and the stored choice before paint through an inline script, so there is no flash (FR-014).
  - The docs host gets its own CSP, set in `apps/docs/Caddyfile`:
    ```
    default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
    ```
    The other headers (HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options) match the app's Caddyfile.
- **Rationale**: Next export emits per-page inline RSC scripts. A hash-based CSP would need a fragile post-build rewrite. The docs origin has no cookies, sessions, forms or user-generated content, and app cookies are host-only (no `domain` set anywhere in `apps/api/src`). So `'unsafe-inline'` on this host does not expose tenant data. This is recorded in the plan's Complexity Tracking (FR-021).
- **Alternatives**: A meta CSP with hashes injected after the build (rejected as fragile). Avoiding Next (does not help, see R1).

## R7 Production serving

- **Decision**:
  - Add a new `docs` service to `infra/compose.prod.yml`, built from `apps/docs/Dockerfile`. It has a `node:24-slim` build stage that runs `pnpm --filter docs build` and a `caddy:2` final stage that serves `out/` with `apps/docs/Caddyfile`.
  - It is published on `127.0.0.1:${DOCS_PORT:-8082}`, with `mem_limit: 64m` and a healthcheck.
  - Host nginx gets a second TLS server block with `server_name replyx.example.com;` (an exact name, which nginx prefers over the wildcard) that proxies to `127.0.0.1:8082`.
  - The existing block becomes `server_name *.replyx.example.com;` and goes to Caddy on 8081 as today. The port 80 redirect block stays as it is.
  - `deploy.sh` also waits for `http://127.0.0.1:${DOCS_PORT}/`.
- **Rationale**: This isolates the docs CSP and the docs build from the app. It uses the same image-based deploy as the rest of the stack, and the owner agreed nginx can change.
- **Today's apex**: The repo's nginx sends the apex to the app's Caddy. The owner reports that the apex shows docs, so the live VM config may differ from the repo. The deploy step **diffs `/etc/nginx/sites-available/replyx.example.com` against the repo file before replacing it**, and keeps a `.bak` (see quickstart step 6).
- **Alternatives**: Serving docs from the app Caddy with a host matcher (rejected because it couples the two releases and branches the CSP). Having nginx serve a directory on disk (rejected because it breaks the image-based deploy).

## R8 Fonts, logo and palette

- **Decision**:
  - Use the design-system tokens in `apps/web/src/theme/tokens.ts` (`designSystemTokens.color.light|dark`, teal `#0D9488` / `#2DD4BF`, slate neutrals, Sora headings, Inter body).
  - Map them onto the Fumadocs CSS variables (`--color-fd-*`) in `global.css` for each theme. The list is in `contracts/theme-tokens.md`.
  - Self-host Sora and Inter with `next/font/local` (woff2 in `public/fonts`).
  - The logo is a docs-local `Logo.tsx` with the same path data as `apps/web/src/components/foundations/Logo.tsx`. `favicon.svg` is copied from `apps/web/public`.
- **Neon (AI elements only)**: an SVG `<filter id="neon">` stacks two `feGaussianBlur` passes (stdDeviation 2 and 6) under the source graphic. The stroke uses `--rx-ai` (dark: `#2DD4BF`; light: `#0D9488`), and the glow uses `--rx-ai-glow` (dark: teal at 0.85 opacity plus a cyan `#22D3EE` tint; light: teal at 0.35 opacity, so lines stay crisp on white). The glow is never used on non-AI nodes (FR-016a).
- **Contrast**: All text in the SVG uses `--rx-text` and `--rx-text-2`, which meet AA on `--rx-surface`. AI strokes are ≥ 3:1 against the background in both themes (WCAG 1.4.11).

## R9 Link checking and tests

- **Decision**:
  - `scripts/check-links.mjs` parses every HTML file in `out/`, collects `href`s that start with `/` or `#`, and checks that each target file and `id` exists. It exits non-zero on failure. It runs in CI after the build.
  - Unit tests (Vitest) cover `complexity.ts` against the 002 formula, plus the scenario invariants from `contracts/flow-scenarios.md`.
  - E2E tests (Playwright, against `npx serve out` or the docs container) cover:
    - the home page autoplays, cycles and pauses when hidden
    - reduce-motion gives a static page
    - JS disabled gives a static page
    - the theme follows the system, with no flash and a persisted choice
    - a 360 px viewport has no horizontal scroll
    - all 21 legacy URLs return 200
    - search finds "triage", "SLA" and "complexity"
    - axe finds 0 serious or critical issues on every page in both themes
- **Rationale**: These map directly to SC-002 through SC-006 and SC-008.

## R10 Search

- **Decision**: Use Fumadocs built-in Orama in **static mode**. `app/api/search/route.ts` uses `createFromSource(source).staticGET` and exports `revalidate = false`, and the UI uses `type: 'static'`. The index is a JSON file under `out/`, fetched same-origin, so `connect-src 'self'` is enough.

## R11 Mermaid blocks

- **Decision**: Keep the two ` ```mermaid ` blocks (`developers/authorization.md`, `developers/deployment.md`) as code blocks, which is how Starlight shows them today.
- **Rationale**: Rendering Mermaid on the client adds about 600 KB. It can be a later enhancement.

## R12 Flow scenarios (made-up data, real math)

- **Decision**: Five scenarios, using the 002 default factors (frustration score w2, several issues w1, technical problem w1, VIP tag w1, Σw = 5) and thresholds t₁ = 0.45, t₂ = 0.80, with a routing confidence threshold of 0.70. They are listed in `contracts/flow-scenarios.md`. The resulting outcomes are Fast ×2, Standard ×1, Advanced ×1 and Needs Triage ×1, and one scenario shows a rule match that skips the decision model.
- **Rationale**: The data shows every branch (FR-006, US1 scenario 3), stays consistent with the documented defaults, and is checked by unit tests so it cannot drift from the formula.

## R13 Docs workflow tooling

- **Decision**:
  - Update `.claude/skills/docs-style/SKILL.md` for the new paths: `apps/docs/content/docs/<group>/`, `meta.json` ordering, frontmatter `title` and `description` (unchanged rule), and the MDX illustration components that concept pages may use.
  - Update the `docs` entry in `.claude/launch.json` to `next dev -p 4321`.
  - Add a `docs` service to `compose.yaml` on port 4321, matching the repo's Docker-first dev workflow.
