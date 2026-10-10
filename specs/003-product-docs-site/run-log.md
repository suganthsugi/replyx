# Run log: 003 Product documentation site

## Resume point

- **Ticked**: T001–T005 (Phases 1–2). **Next**: US3, starting at T006.
- **Jira** (cloudId `f83a4d0c-9614-4404-8ea3-98d37ad873b8`):
  - RX-65 is the Story for Phases 1–2 (Done, screenshot attached).
  - Its tasks are RX-66 (T001), RX-67 (T002), RX-68 (T003), RX-69 (T004) and RX-70 (T005), all Done.
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
