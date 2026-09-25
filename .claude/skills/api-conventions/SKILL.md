---
name: api-conventions
description: AppError envelope, zod .strict() validation and issue codes, cursor pagination, access decorators, guard order, CSRF, rate limits, openapi.yaml rules. Use when adding or reviewing API endpoints.
---

# api-conventions

HTTP API rules for `apps/api`. Loaded by backend-agent, frontend-connector and reviewer. Kernel:
`apps/api/src/platform-kernel/http/`, `apps/api/src/authorization/`. The probe controller in
`apps/api/test/integration/http/kernel.test.ts` is the reference endpoint.

## Rules

1. **Throw `AppError` or its helpers** from `platform-kernel/http/app-error.ts`, never Nest HTTP
   exceptions: `notFound(resource)` (404 `<RESOURCE>_NOT_FOUND`, e.g. `notFound('ticket')` →
   `TICKET_NOT_FOUND` / "Ticket not found"), `permissionDenied()` (403 `PERMISSION_DENIED`),
   `conflict(code, message?)` (409), `unauthenticated()`, `validationFailed(details)`,
   `rateLimited(seconds)`. Other statuses: `new AppError(CODE, status, message)`, code matching
   `^[A-Z][A-Z0-9_]+$` (e.g. `accountLocked()` 423 in `identity/lockout.service.ts`).
   Wrong: `throw new NotFoundException()` / `res.status(404).json({ message })`

2. **Error body is always** `{ "error": { "code", "message", "details"?, "retryAfter"? } }`.
   `ErrorFilter` (`error.filter.ts`) maps non-`AppError` 4xx by status (unknown route → 404
   `NOT_FOUND` / "Not found") and everything else to 500 `INTERNAL` "Something went wrong"; the
   stack goes to the log only. `retryAfter` also sets the `Retry-After` header.

3. **Status map**: 400 `VALIDATION_FAILED`, 401 `UNAUTHENTICATED`, 403 `PERMISSION_DENIED` /
   `CSRF_FAILED`, 404 `*_NOT_FOUND` (unknown tenant host: `TENANT_NOT_FOUND`), 409 conflicts,
   413/415 attachments, 423 `ACCOUNT_LOCKED`, 429 `RATE_LIMITED`, 503 `TENANT_SUSPENDED`.
   **403 vs 404**: another tenant's, or invisible (policy decision `not_found`), is 404 identical
   to a missing id; 403 only when visible but the action is denied.
   Wrong: 403 for a ticket in a group the agent cannot view

4. **Validate every body/query/params with a zod `.strict()` object through `ZodValidationPipe`**
   (`validation.pipe.ts`). Failures: 400 with `details: [{ path, issue }]`, `path` dot-joined
   (`items.0.id`). Issue codes (clients rely on them): `required`, `invalid_type`,
   `unrecognized_key`, `too_long`/`too_short` (strings), `too_many`/`too_few` (arrays),
   `too_large`/`too_small` (numbers), `invalid_format`, `invalid_value`, `invalid`,
   `invalid_cursor`. Use the parsed value only (coerced, whitelisted).
   ```ts
   // from apps/api/test/integration/http/kernel.test.ts
   const CreateItem = z.object({ name: z.string().min(1).max(5) }).strict();

   @Controller('probe')
   class ProbeController {
     @Post('items')
     @RequirePermission('group.create')
     create(@Body(new ZodValidationPipe(CreateItem)) body: z.infer<typeof CreateItem>) {
       return { name: body.name };
     }
   }
   ```
   Wrong: `@Body() body: CreateDto` / `z.object({...})` without `.strict()` / `.passthrough()` /
   accepting `tenantId` in any input

5. **Explicit response DTOs.** Map rows to the contract schema; never return a Kysely row (no
   `tenant_id`, `password_hash`, `token_hash`). camelCase JSON, UUID ids, ISO 8601 UTC timestamps.
   Wrong: `return this.selectFrom(tx, 'users').selectAll().execute()`

6. **Lists are cursor-paginated** with `pagination.ts`: spread `paginationQuery` into the query
   schema (`limit` 1–100 default 25, `cursor`), order by a stable key plus `id`, fetch `limit + 1`,
   and return `toPage(rows, limit, positionOf, toItem)` → `{ items, nextCursor }`. Decode with
   `decodeCursor(cursor, PositionSchema)` (bad cursor → 400 `invalid_cursor`).
   ```ts
   // target shape (pagination.ts API)
   const ListQuery = z.object({ ...paginationQuery, state: TicketState.optional() }).strict();
   ```
   Wrong: `?page=2`, `offset`, a bare array, or a `total` count

7. **Exactly one access decorator per route** (handler, or controller-level), from
   `authorization/registry/module-permissions.ts`; `route-audit.ts` fails api start-up otherwise:
   - `@RequirePermission('resource.action')`: staff only; the key must be declared with
     `definePermissions()` (today: `registry/initial-permissions.ts`) and registered via
     `permissionsProvider()`.
   - `@StaffApi()`: any signed-in staff user, no permission key; only for the caller's own
     account (sign-out, `/me`). Customers get 404.
   - `@Public()`: no session (sign-in, branding, health). Exempt from CSRF.
   - `@CustomerApi()`: must live under `customer/`, and only customer routes may.
   - `@OperatorApi()`: must live under `platform/`; console host + `req.operator` only.
   `@AllowSuspended()` (`tenant-resolver.middleware.ts`) is an extra marker; without it a suspended
   tenant gets 503. `@RateLimit(name)` is also extra.
   Wrong: no decorator; `@Public()` + `@RequirePermission()`; `if (user.role === 'admin')`

8. **Global guard order** (`src/api-pipeline.module.ts`): `TenantStatusGuard` → `CsrfGuard` →
   `AuthGuard` → `RateLimitGuard` → `PermissionGuard`. `PermissionGuard` answers `NOT_FOUND`
   "Not found" (same as an unknown route) for cross-audience calls: customer on a staff route,
   staff on `/customer/*`, operator route off the console host. For resource visibility, services
   call `PolicyService.can(ctx, key, { type: 'ticket', groupId })` (`'allow'|'deny'|'not_found'`)
   or `await policy.ticketAccessFilter(ctx, action, 'tickets.group_id')` for list queries.
   Build `ctx` with `tenantContextOf(req)`.
   Wrong: `if (decision !== 'allow') throw permissionDenied()` (drops the `not_found` case)

9. **Access changes bump the version**: every change to roles, role permissions, group access,
   user roles or user status calls `bumpAccessVersion(tx, tenantId, reason)`
   (`authorization/access-version.ts`) in the same transaction (appends `access.changed`).

10. **Customer vs staff surfaces are separate.** `/api/v1/customer/*` never exposes tickets,
    ticket numbers, states, groups, owners, priorities, SLA or internal notes. Customer DTOs live
    beside customer controllers; don't reuse staff DTOs.
    Wrong: a customer message DTO containing `ticketId` or `state`

11. **Cookies and CSRF** (`cookies.ts`, `csrf.guard.ts`): `rx_session` (HttpOnly) and `rx_csrf`
    (readable), both `Secure; SameSite=Lax; Path=/`, host-only (never set `Domain`). Non-GET/HEAD/
    OPTIONS on non-`@Public()` routes (including `@OperatorApi()`) need `X-CSRF-Token` equal to
    `rx_csrf`, else 403 `CSRF_FAILED`. Sign-in calls `issueCsrfCookie(res, maxAge)` next to
    `SessionService.setCookie`; sign-out calls `clearCsrfCookie`.

12. **Rate limits** (`rate-limit.ts`): `@RateLimit('sign-in' | 'sign-in-link' | 'customer-message')`
    on the route (10/min/IP, 5/h/email, 20/min/customer); `api` (600/min/session) runs for every
    request with a session. Non-HTTP code calls `RateLimiter.consume(policy, tenantId, subject)`.
    Redis down = allowed (logged). Sign-in checks `LockoutService.isLocked` before verifying.

13. **Routes live under `/api/v1`** (`API_PREFIX` in `app.setup.ts`); only `health/live` and
    `health/ready` are unprefixed and skip tenant resolution.

14. **`apps/api/openapi.yaml` is the single source of truth** (orval builds the web client).
    Per operation: camelCase `operationId` (`listGroups`), exactly one tag from `identity`,
    `access`, `tickets`, `operations`, `customer` (`platform` is added with T081), shared
    `$ref`s (`parameters`: `Limit`, `Cursor`, `IdPath`, `IdempotencyKey`; `responses`:
    `ValidationFailed`, `Unauthenticated`, `PermissionDenied`, `NotFound`, `Conflict`,
    `RateLimited`), `additionalProperties: false` on request bodies, `security: []` only for
    `@Public()` routes. Then run `scripts/generate-api-client.sh` and commit the output (CI checks
    freshness). Creating POSTs accept optional `Idempotency-Key`; message sends carry
    `clientMessageId`.
    Wrong: `operationId: list_groups`, two tags, inline copies of shared responses

## Checklist (before reporting done)
- [ ] Errors are `AppError`/helpers; invisible or other-tenant resources return 404, not 403
- [ ] Every input goes through `ZodValidationPipe` with a `.strict()` schema
- [ ] Response is an explicit DTO; lists use `paginationQuery` + `toPage`
- [ ] Exactly one of `@RequirePermission`/`@StaffApi`/`@Public`/`@CustomerApi`/`@OperatorApi`; path prefix matches
- [ ] New permission keys declared with `definePermissions`; access changes call `bumpAccessVersion`
- [ ] Customer endpoints expose no ticket concepts
- [ ] openapi.yaml: camelCase `operationId`, one tag, shared `$ref`s; client regenerated
