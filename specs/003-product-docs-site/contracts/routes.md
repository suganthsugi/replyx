# Contract: Routes, hosts and headers

## Hosts (production)

| Host | nginx block | Upstream | Serves |
|---|---|---|---|
| `replyx.example.com` | exact `server_name replyx.example.com` (new) | `127.0.0.1:${DOCS_PORT:-8082}` → `docs` container | Docs site (this feature) |
| `*.replyx.example.com` (tenants, `console.`) | wildcard block (existing, narrowed) | `127.0.0.1:${CADDY_PORT:-8081}` → `caddy` container | App: workspace, customer chat, console, `/api`, `/rt` (unchanged) |

Port 80 redirects to https for both, as today.

## Docs URLs (trailing slash, `index.html` per folder)

| URL | Page |
|---|---|
| `/` | Home: animated flow hero and section cards |
| `/concepts/how-ai-routing-works/` | NEW |
| `/concepts/how-complexity-picks-a-model/` | NEW |
| `/guides/{ai-assist, custom-views, customer-chat, macros-merge-split, search, signing-in, triage, views-and-notifications, working-tickets}/` | migrated (9) |
| `/admin/{audit-and-retention, organization-settings, roles-and-groups, routing-rules, sla-and-business-hours, support-access, users}/` | migrated (7) |
| `/operators/tenants/` | migrated (1) |
| `/developers/{authorization, conversation-routing, deployment}/` | migrated (3) |
| `/api/search/` | static search index (JSON) |
| anything else | `404.html` (a themed not-found page with a link home) |

There are 20 migrated content pages plus the old `index.mdx`, which is replaced by `/`. That makes 21 legacy URLs, all of which must return 200.

## Response headers (docs container)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Cache-Control: /_next/static/* → public, max-age=31536000, immutable; HTML → no-cache
```
