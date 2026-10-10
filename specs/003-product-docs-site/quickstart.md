# Quickstart: validate the product documentation site

## Prerequisites

- Docker Desktop. The repo's dev stack runs in Compose.
- The new `docs` service is defined in `compose.yaml`.

## 1. Run in development

```sh
docker compose up -d docs          # next dev on http://localhost:4321
```

Open http://localhost:4321/.
- **Expected**: the hero flow starts playing within about 1 s, and it loops through the 5 scenarios in `contracts/flow-scenarios.md`.

## 2. Unit checks

```sh
docker compose run --rm docs pnpm --filter docs test
```

- **Expected**: the complexity formula, the scenario invariants, the `meta.json` coverage, and the "no hex colours in illustrations" checks all pass.

## 3. Static build and link check

```sh
docker compose run --rm docs pnpm --filter docs build      # writes apps/docs/out
docker compose run --rm docs pnpm --filter docs check:links
```

- **Expected**: `out/index.html` exists, plus one folder per URL in `contracts/routes.md`, and 0 broken internal links or anchors.

## 4. End-to-end and accessibility

```sh
docker compose run --rm docs pnpm --filter docs test:e2e
```

**Expected (each is a test)**:
- The home page autoplays, and a full loop shows Fast, Standard, Advanced and Needs Triage.
- The animation pauses when the tab is hidden.
- `prefers-reduced-motion: reduce` shows the complete static diagram, and no WAAPI animations are running.
- With JS disabled, the diagram, captions and navigation are visible.
- The theme follows `colorScheme: dark` and `light` with no flash, and a manual choice persists after reload.
- At 360 px wide there is no horizontal scroll, and the flow uses the vertical layout.
- All 21 legacy URLs return 200.
- Search for "triage", "SLA" and "complexity" returns the expected pages.
- axe finds 0 serious or critical issues on every route, in light and in dark.

## 5. Production image locally

```sh
docker build -f apps/docs/Dockerfile -t replyx-docs .
docker run --rm -p 8082:80 replyx-docs
curl -sI http://localhost:8082/ | grep -i content-security-policy
```

- **Expected**: the CSP from `contracts/routes.md`, and the site renders at http://localhost:8082/.

## 6. Deploy (VM, owner-run)

1. Check the live nginx against the repo before replacing it:
   ```sh
   diff /etc/nginx/sites-available/replyx.example.com infra/nginx/replyx.conf
   ```
   If the live file has docs-specific changes, keep a backup with `sudo cp … …bak-2026-10-xx`.
2. Install the new nginx file, then run `sudo nginx -t && sudo systemctl reload nginx`.
3. Run `bash infra/scripts/deploy.sh`.
- **Expected**:
  - https://replyx.example.com/ shows the new home page.
  - https://replyx.example.com/guides/triage/ loads.
  - A tenant host such as `https://<slug>.replyx.example.com/desk` and the console host still load the app.
