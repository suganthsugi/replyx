# Run log: 003 Product documentation site

## Resume point

- **Ticked**: T001–T023 (Phases 1–2, US3, US2, US1, US4). **Next**: US5 at T024, then Phase 8.
- **Jira** (cloudId `f83a4d0c-9614-4404-8ea3-98d37ad873b8`):
  - RX-65 is the Story for Phases 1–2 (Done, screenshot attached).
  - Its tasks are RX-66 (T001), RX-67 (T002), RX-68 (T003), RX-69 (T004) and RX-70 (T005), all Done.
  - RX-71 is the US3 Story (Done, screenshot attached), with tasks RX-72 (T006) to RX-76 (T010), all Done.
  - RX-77 is the US2 Story (Done, light and dark screenshots attached), with tasks RX-78 (T011), RX-79 (T012) and RX-80 (T013), all Done.
  - RX-81 is the US1 Story (Done after the owner's motion-reel feedback, 6 screenshots attached), with tasks RX-82 (T014) to RX-88 (T020), all Done.
  - RX-89 is the US4 Story (Done), with tasks RX-90 (T021), RX-91 (T022) and RX-92 (T023), all Done with screenshots.
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
