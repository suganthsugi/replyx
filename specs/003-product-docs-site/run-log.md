# Run log: 003 Product documentation site

## Resume point

- **Ticked**: T001–T030, all tasks. **Waiting on**: the owner's VM deploy (quickstart step 6, commands under "T030 results").
- **Jira** (cloudId `f83a4d0c-9614-4404-8ea3-98d37ad873b8`):
  - RX-65 is the Story for Phases 1–2 (Done, screenshot attached).
  - Its tasks are RX-66 (T001), RX-67 (T002), RX-68 (T003), RX-69 (T004) and RX-70 (T005), all Done.
  - RX-71 is the US3 Story (Done, screenshot attached), with tasks RX-72 (T006) to RX-76 (T010), all Done.
  - RX-77 is the US2 Story (Done, light and dark screenshots attached), with tasks RX-78 (T011), RX-79 (T012) and RX-80 (T013), all Done.
  - RX-81 is the US1 Story (Done after the owner's motion-reel feedback, 6 screenshots attached), with tasks RX-82 (T014) to RX-88 (T020), all Done.
  - RX-89 is the US4 Story (Done), with tasks RX-90 (T021), RX-91 (T022) and RX-92 (T023), all Done with screenshots.
  - RX-93 is the US5 Story (Done), with tasks RX-94 (T024, screenshots) and RX-95 (T025), both Done.
  - RX-96 is the Phase 8 Story, with tasks RX-97 (T026), RX-98 (T027), RX-99 (T028), RX-100 (T029) and RX-101 (T030).
  - Team-managed project: a Task can't have a Story as its parent, so each task description says "Part of story RX-xx" instead.
  - Screenshots use `uploadAttachmentToJiraIssue` through `executeWrite`. Phase 1 returns a curl command; run it, then embed the returned id inline in a comment.

## How to run

- Dev server: `docker compose up -d --no-deps docs`, then open http://127.0.0.1:4321.
  - Use 127.0.0.1, not `localhost`. A host Node process may hold `[::1]:4321`.
  - Restart the container after adding route folders; file watching on the Windows bind mount misses them.
- Build: `docker compose run --rm tools pnpm --filter docs build`, which writes `apps/docs/out/`.
- Unit tests: `docker compose run --rm tools pnpm --filter docs test`.
- Typecheck: `docker compose run --rm tools pnpm --filter docs typecheck`.
- E2E (after a build): `docker compose --profile e2e run --rm playwright pnpm --filter docs test:e2e`.

## Decisions and findings

- Versions follow the official `create-fumadocs-app` `+next+fuma-docs-mdx+static` template:
  - Next 16.3.8
  - `fumadocs-ui` = `@fumadocs/base-ui` 16.17.1
  - `fumadocs-core` 16.17.1
  - `fumadocs-mdx` 15.4.7, using the `defineDocs` macro (no `source.config.ts`)
- The `build` script sets `NODE_ENV=production`. The dev `.env` sets `NODE_ENV=development`, which breaks prerendering with a null `useContext` error.
- Turbopack warns that it can't parse Tailwind's `::highlight(fd-search)` selector from Fumadocs UI. It is only a warning; the build succeeds.
- `tsconfig` leaves out `.next/dev/types`. Stale dev-server route types otherwise fail `next build`.
- Fumadocs normalizes page URLs without a trailing slash (`normalizeUrl`), and search results use those. Next adds the slash to rendered links. The production server must answer both forms (T026: `try_files {path} {path}/index.html`).
- Fonts are `@fontsource-variable/inter` and `@fontsource-variable/sora`, loaded through `next/font/local`, so there is no external font origin.
- axe flags color contrast on Fumadocs' default neutral muted text. T011 fixes this.
- US3:
  - The old "API reference" sidebar link was dropped. It pointed at `localhost:3000/api/docs`, and nothing in `apps/api` serves an API reference.
  - The docs-style skill was corrected to say so.
- US2:
  - Added `--rx-primary-text` (light `#0F766E`), because light `#0D9488` is too low-contrast for link text.
  - Code blocks use `github-light-high-contrast` and `github-dark-high-contrast`.
  - Markdown task-list checkboxes are `aria-hidden`.
  - axe is clean on all 21 pages in both themes.
- next-themes puts its inline theme script at the top of `<body>`, not in `<head>`. The no-flash test checks that `<html>` has its theme class before the first h1 is parsed.
- e2e flake: clicks can land before React hydrates the static HTML. Interactive steps retry with `expect(...).toPass()`.
- Gotcha: a shell chain like `test | grep … && git commit` commits even when tests fail. Check the test exit code explicitly.
- US1:
  - After owner feedback, the diagram became a kinetic motion reel (`FlowReel.tsx`, `motion.tsx`, `reel.module.css`): big type per beat, HUD labels, a tile wipe between tickets.
  - The stage captions are HTML `<a>` links in the reel's chapter bar, and the figure is not `role="img"` (research R5, revised).
  - The reel is sized in container-query units and switches to a portrait frame below 700 px.
  - Beat timing lives in one storyboard (`AT`, `holdFor`, `COUNT_WINDOW` in `FlowReel.tsx`). `?speed=N` speeds everything up for tests.
  - FlowPlayer awaits one Web Animations API animation per step, so pausing every animation in the figure also pauses the sequence.
  - Pause gotchas: resume only the animations the player paused (play() rewinds a finished one); text timers are handed to the player (`adopt`); a `data-paused` attribute freezes CSS entrances that start while hidden; state changes wait until the reel is visible.
  - The flow JS size must be re-measured in T030 (it was 7.5 KB gzipped before the reel).
- Docs e2e runs 4 workers locally and 2 in CI. With 8 workers, the shared 8 GB Docker VM ran out of memory (ENOMEM in `serve`).
- US4:
  - The concept illustrations reuse the reel's `CoreOrb` and `ComplexityRing`, placed inside one `role="img"` SVG through their `place` prop. Their numbers come from scenario 3 and `complexity.ts`.
  - The diagrams are 560 units wide, so their labels stay readable at 360 px (about 0.6 scale).
  - Fumadocs wraps MDX tables in a scrolling div that keyboard users can't focus (axe scrollable-region-focusable on phones). `components/mdx.tsx` replaces it with a focusable, named region.
  - Sora renders word spaces narrow in SVG text, so diagram names use `word-spacing: 0.12em`.
- The link checker passes (900 links in 26 pages).
- US5: the section cards reuse the shared `Icon` set from `components/flow/primitives.tsx` (`inbox` and `code` were added). Only the AI assist icon glows.
- Phase 8:
  - The docs image is about 20 MB of real memory under load (200 concurrent compressed requests), so `mem_limit: 64m` is safe. `docker stats` shows about 64 MB, but most of that is reclaimable file cache.
  - `/api/search` has no file extension, so the Caddyfile names its type (`application/json`).
  - `nginx -t` was checked in an `nginx:1.27-alpine` container with a throwaway certificate.
  - The workflow was linted with actionlint 1.7.7 and has not run on GitHub yet. With Git Bash, run the container with `MSYS_NO_PATHCONV=1`.
  - Measuring: Chromium in the Playwright image ignores CDP `Network.emulateNetworkConditions` (TTFB stays about 9 ms), and the production CSP's `upgrade-insecure-requests` blocks every script over plain-HTTP localhost. So measure with Lighthouse `--throttling-method=devtools` against `serve out`. Lighthouse's default simulated mode reports LCP 2.9–4.5 s, but a real trace shows the LCP paragraph painting once, at FCP. The simulation charges it for every script that runs before that.

## T030 results (2026-10-11)

| Quickstart step | Result |
|---|---|
| 1. Dev server | Not run: it would restart the owner's dev `docs` container (house rule). The same build is covered by steps 3 to 5. |
| 2. Unit checks | 81 passed (complexity, scenarios, meta coverage, no hex in illustrations). |
| 3. Build and links | `out/` has `index.html`, a folder per route and `404.html`. `check:links` reports 914 internal links in 26 pages, all resolved. |
| 4. E2E and axe | 105 passed, 1 skipped, on chromium-desktop and mobile-360. This covers autoplay, every level plus Needs Triage, hidden-tab pause, reduced motion, no JS, themes with no flash, 360 px, the legacy URLs, search, the concept pages, the cards, and axe in both themes. |
| 5. Production image | `replyx-docs:local` sends exactly the contract CSP and headers, no `Server`, immutable `/_next/static`, `no-cache` pages, a 404 for unknown paths, and a healthy healthcheck. |

Home page on Slow 4G (Lighthouse 12.8.2, devtools throttling: 562.5 ms request latency, 1.47 Mbps down, 4x CPU, mobile):

| Run | LCP | CLS | FCP | TBT |
|---|---|---|---|---|
| 1 | 1.78 s | 0.013 | 1.78 s | 742 ms |
| 2 | 2.00 s | 0.015 | 2.00 s | 887 ms |
| 3 | 1.77 s | 0.011 | 1.77 s | 3421 ms |

- The budgets pass: LCP ≤ 2.5 s, CLS < 0.05. Desktop (Lighthouse desktop preset) has LCP 0.68–0.86 s.
- TBT is high on a 4x-throttled CPU, mostly from the Next/React framework chunk (71 KB gzip) and the reel's start. It has no budget; worth watching.
- The flow JS is one 9.1 KB gzip chunk (`FlowReel`, `motion`, scenarios and the reel CSS class map), within the 15 KB budget.
- The page transfers 449 KB in total, including both variable fonts (80 KB) and Next's link prefetches.

Owner deploy (quickstart step 6, on the VM, not run here):

```sh
cd ~/replyx && git pull --ff-only
grep -q '^DOCS_PORT=' infra/.env.prod || echo 'DOCS_PORT=8082' >> infra/.env.prod
diff /etc/nginx/sites-available/replyx.example.com infra/nginx/replyx.conf
sudo cp /etc/nginx/sites-available/replyx.example.com /etc/nginx/sites-available/replyx.example.com.bak-$(date +%F)
bash infra/scripts/deploy.sh
curl -sI http://127.0.0.1:8082/ | head -1
sudo cp infra/nginx/replyx.conf /etc/nginx/sites-available/replyx.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Deploy first, then switch nginx, so the apex never points at a port with nothing behind it. Afterwards, check that https://replyx.example.com/ shows the new home page, that https://replyx.example.com/guides/triage/ loads, and that a tenant host (`https://<slug>.replyx.example.com/desk`) and the console still load the app.
