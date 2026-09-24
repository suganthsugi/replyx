---
name: api-conventions
description: AppError and error format, zod validation, cursor pagination, route decorators, openapi.yaml operationIds/tags, customer vs staff APIs, CSRF, rate limits. Use when adding or reviewing API endpoints.
---

# api-conventions

HTTP API rules for `apps/api`. Loaded by backend-agent, frontend-connector and reviewer.
Real today: `apps/api/openapi.yaml` (shared components, tags). Kernel code (T022–T031) does not
exist yet; TS examples are target shapes from `specs/001-multi-tenant-helpdesk/contracts/README.md`
and tasks.md.

## Rules

1. **Throw `AppError`, never Nest HTTP exceptions or raw objects.** `AppError(code, httpStatus,
   message, details?)` plus helpers `notFound(resource)`, `permissionDenied()`, `conflict(code)`
   in `platform-kernel/http/app-error.ts`. Codes are `^[A-Z][A-Z0-9_]+$`.
   ```ts
   // target shape (tasks.md T022)
   if (!ticket) throw notFound('ticket');           // 404 TICKET_NOT_FOUND
   if (ticket.triagedAt) throw conflict('ALREADY_TRIAGED'); // 409
   ```
   Wrong: `throw new NotFoundException()` / `res.status(404).json({ message })`

2. **Error body is always** `{ "error": { "code", "message", "details"? } }` (`ErrorResponse` in
   `apps/api/openapi.yaml`). `error.filter.ts` maps unknown errors to 500 `INTERNAL` with a
   generic message: no stack, SQL, or class names. `details` only for validation;
   `retryAfter` only for `RATE_LIMITED`.

3. **Status map** (contracts/README.md): 400 `VALIDATION_FAILED`, 401 `UNAUTHENTICATED`,
   403 `PERMISSION_DENIED` / `CSRF_FAILED`, 404 `*_NOT_FOUND`, 409 state conflicts, 413/415
   attachments, 423 `ACCOUNT_LOCKED`, 429 `RATE_LIMITED`, 503 `TENANT_SUSPENDED`.
   **403 vs 404**: if the caller cannot *see* the resource (other tenant, or ticket outside their
   group access, i.e. policy `can()` returns `not_found`) answer 404 identical to a missing id.
   403 only when visible but the action is not allowed.
   Wrong: 403 for a ticket in a group the agent cannot view

4. **Validate every body/query/param with a zod schema; unknown fields are rejected.** Use
   `.strict()` objects; the validation pipe returns 400 `VALIDATION_FAILED` with
   `details: [{ path, issue }]` (`path` dot-joined, e.g. `"title"`, `"items.0.id"`; `issue` a
   snake_case reason such as `too_long`, `required`, `unrecognized_key`).
   ```ts
   // target shape (tasks.md T022, contracts/README.md)
   const CreateGroupBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();
   @Post() @RequirePermission('group.create')
   create(@Body(new ZodValidationPipe(CreateGroupBody)) body: z.infer<typeof CreateGroupBody>) {}
   ```
   Wrong: `@Body() body: any` / `z.object({...}).passthrough()` / accepting `tenantId` in a body

5. **Explicit response DTOs.** Map rows to the response schema; never return a Kysely row
   (no `tenant_id`, `password_hash`, `token_hash`, internal flags). camelCase JSON, UUID ids,
   ISO 8601 UTC timestamps.
   Wrong: `return tx.selectFrom('users').selectAll().execute()`

6. **Lists are cursor-paginated.** Query `limit` (1–100, default 25) and opaque `cursor`;
   response `{ items: [...], nextCursor: string | null }`. Use `platform-kernel/http/pagination.ts`
   to encode/decode; order by a stable key plus `id`; fetch `limit + 1` to compute `nextCursor`.
   Invalid cursor → 400 `VALIDATION_FAILED`.
   Wrong: `?page=2&pageSize=20`, `offset`, a bare array response, or a `total` computed per page

7. **Every route has exactly one access decorator** (T029/T031, enforced by
   `authorization/registry/route-audit.ts` at start-up):
   - `@RequirePermission('resource.action')` staff route, checked by the global permission guard
     through the policy service (constitution II); key must exist in a `ModulePermissions`
     declaration.
   - `@Public()` no session (sign-in, branding, health).
   - `@CustomerApi()` routes under `/customer/*`; authorization is by ownership of the caller's
     own conversation.
   - `@OperatorApi()` platform console routes under `/platform/*` on `CONSOLE_HOST` only.
   `@AllowSuspended()` is an additional marker letting a route answer while the tenant is
   suspended (otherwise 503 `TENANT_SUSPENDED`).
   Wrong: a controller route with no decorator; `if (user.role === 'admin')` in a handler

8. **Customer vs staff surfaces are separate.** Customer API (`/api/v1/customer`) never exposes
   tickets, ticket numbers, states, groups, owners, priorities, SLA or internal notes
   (customer.yaml, research D9). A customer session on a staff route, or a staff session on
   `/customer/*`, gets 404 (not 403). Customer DTOs live beside customer controllers; do not reuse
   staff DTOs.
   Wrong: `CustomerMessage` containing `ticketId` or `state`

9. **CSRF.** Every non-GET request needs header `X-CSRF-Token` equal to the `rx_csrf` cookie, else
   403 `CSRF_FAILED` (`platform-kernel/http/csrf.guard.ts`, T026). Session cookie is `rx_session`
   (`rx_op_session` on the console), `HttpOnly; Secure; SameSite=Lax`, host-only.

10. **Rate limits** (`platform-kernel/http/rate-limit.ts`, T028, research D19): named policies
    `sign-in` 10/min/IP, `sign-in-link` 5/h/email, `customer-message` 20/min/customer,
    `api` 600/min/session. Exceeding → 429 `RATE_LIMITED`, `Retry-After` header (seconds) and
    `error.retryAfter` in the body. Declare the 429 with `$ref: '#/components/responses/RateLimited'`.

11. **Idempotency.** Message sends carry a client `clientMessageId` (UUID); other creating POSTs
    accept optional `Idempotency-Key` (`$ref: '#/components/parameters/IdempotencyKey'`, 24 h).

12. **`apps/api/openapi.yaml` is the single source of truth** (orval generates the web client
    from it). When merging an endpoint from `contracts/*.yaml`:
    - camelCase `operationId` (`listTickets`, `triageTicket`, `getCustomerConversation`);
    - exactly one tag from `identity`, `access`, `tickets`, `operations`, `customer`, `platform`
      (the `platform` tag is not declared yet; add it to `tags:` when merging platform.yaml);
    - reuse `components/parameters` (`Limit`, `Cursor`, `IdPath`, `IdempotencyKey`) and
      `components/responses` (`ValidationFailed`, `Unauthenticated`, `PermissionDenied`,
      `NotFound`, `Conflict`, `RateLimited`) instead of inline copies;
    - `additionalProperties: false` on request bodies; `security: []` only on `@Public()` routes.
    ```yaml
    # target shape (contracts/README.md "operationId")
    /groups:
      get:
        operationId: listGroups
        tags: [access]
        parameters: [{ $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }]
        responses:
          '200': { description: Page of groups, content: { application/json: { schema: { $ref: '#/components/schemas/GroupPage' } } } }
          '401': { $ref: '#/components/responses/Unauthenticated' }
          '403': { $ref: '#/components/responses/PermissionDenied' }
    ```
    Wrong: `operationId: list_groups` / `GetGroups`, two tags, or no tag
    After editing, regenerate the client (`scripts/generate-api-client.sh`); CI checks freshness.

## Checklist (before reporting done)
- [ ] Errors thrown as `AppError`/helpers; body matches `ErrorResponse`; 500s leak nothing
- [ ] Invisible or other-tenant resources return 404, not 403
- [ ] zod `.strict()` schema on every input; 400 `VALIDATION_FAILED` with `details[{path, issue}]`
- [ ] Response is an explicit DTO; lists return `{ items, nextCursor }` with `limit` 1–100 default 25
- [ ] Exactly one of `@RequirePermission`/`@Public`/`@CustomerApi`/`@OperatorApi` per route
- [ ] Customer endpoints expose no ticket concepts; cross-surface calls return 404
- [ ] Non-GET routes are CSRF-guarded; rate-limited routes document 429 + `Retry-After`
- [ ] openapi.yaml: camelCase `operationId`, one allowed tag, shared `$ref`s; client regenerated
