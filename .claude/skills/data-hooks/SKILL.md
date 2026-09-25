---
name: data-hooks
description: apps/web/src/data - orval client wrapping, http mutator (CSRF, HttpError), mapError, query keys, RealtimeClient cache updates. Use when adding hooks in apps/web/src/data or calling the API from a component.
---

# data-hooks

Scope: `apps/web/src/data` (`http.ts`, `errors.ts`, `query-client.ts`, `socket.ts`), the only layer
that imports `apps/web/src/api/generated`. Loaded by frontend-connector. Feature hook files
(`src/data/<resource>.ts`) don't exist yet: their snippets are target shapes.

## Rules

1. **Never edit `src/api/generated/`.** orval (`orval.config.ts`: `tags-split`, `react-query`
   client, endpoints per tag + `model/`, mutator `http`, `includeHttpResponseReturnType: false`)
   generates it from `apps/api/openapi.yaml`. After a spec change run
   `bash scripts/generate-api-client.sh` and commit the output (CI checks freshness). Components
   and pages import from `src/data`, never from `src/api/generated`.
   Wrong: hand-editing a generated hook; `import { useListGroups } from '../api/generated/...'` in a page

2. **All HTTP goes through `http<T>(url, options)`** (`data/http.ts`, the orval mutator):
   same-origin, paths resolved against `/api/v1` (`resolveUrl`), `credentials: 'include'`,
   `X-CSRF-Token` from the `rx_csrf` cookie on non-GET/HEAD/OPTIONS, JSON content type for string
   bodies, resolves to the parsed body (`undefined` for 204). Non-2xx throws
   `HttpError { status, error: { code, message, details?, retryAfter? } }`; `retryAfter` falls back
   to the `Retry-After` header; a non-envelope body becomes `INTERNAL`/`HTTP_ERROR`.
   Wrong: calling `fetch` directly; reading `rx_csrf` in a component; absolute API origins

3. **Map errors once with `mapError(raw)`** (`data/errors.ts`) → `UiError { code, message,
   retryAfter?, fieldErrors? }`. Non-envelope failures → `NETWORK_ERROR`. `fieldErrors` maps the
   API `details[].path` (`title`, `items.0.id`) to the snake_case issue (`required`, `too_long`,
   `unrecognized_key`, ...; see api-conventions rule 4). Friendly messages replace `INTERNAL`,
   `CSRF_FAILED`, `UNAUTHENTICATED`, `TENANT_SUSPENDED`. Branch on `code`, never on status: 404
   also means "not visible to you".
   ```ts
   // from apps/web/src/data/errors.ts
   export function mapError(raw: unknown): UiError {
     if (!isApiError(raw)) return NETWORK_ERROR;
     const { code, message, details, retryAfter } = raw.error;
     const fieldErrors = toFieldErrors(details);
     return { code, message: FRIENDLY_MESSAGES[code] ?? message,
       ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
       ...(fieldErrors === undefined ? {} : { fieldErrors }) };
   }
   ```
   Wrong: `if (err.status === 404)` in a component; rendering `String(error)`

4. **Query client defaults** (`createQueryClient()` in `query-client.ts`, built in `main.tsx`,
   provided by `App`): `staleTime` 30 s, `gcTime` 5 min, no refetch on focus, retries up to 2 but
   never for permanent 4xx (`isPermanentFailure`, 429 excepted), mutations never retry. Don't
   override per hook without a reason in the code; idempotent sends use `clientMessageId`.
   Wrong: `retry: 3` on a mutation; `refetchInterval` polling for data the socket already pushes

5. **Query keys: one factory per resource in its hook file**, hierarchical arrays, exported so
   socket handlers can target them.
   ```ts
   // target shape (src/data/groups.ts)
   export const groupKeys = {
     all: ['groups'] as const,
     list: (filters: GroupFilters) => [...groupKeys.all, 'list', filters] as const,
     detail: (id: string) => [...groupKeys.all, 'detail', id] as const,
   };
   ```
   Wrong: `queryKey: ['group-' + id]` (breaks prefix invalidation); keys inlined in components

6. **A feature hook wraps one generated hook** and returns typed data plus a mapped error; it
   passes its own key.
   ```ts
   // target shape (src/data/groups.ts; generated hook name comes from the operationId)
   export function useGroup(id: string) {
     const query = useGetGroup(id, { query: { queryKey: groupKeys.detail(id) } });
     return { ...query, error: query.error ? mapError(query.error) : undefined };
   }
   ```
   Mutations invalidate or patch the affected keys in `onSuccess`; forms get the raw error thrown
   (the shell `Form` maps it) so field errors reach `FormField`.

7. **Real time goes through `RealtimeClient`** (`data/socket.ts`), one per area: staff namespace
   `/`, customers `/customer`, path `/rt`, same origin. It listens to the **`event`** envelope
   (`{ id, seq, stream, type, occurredAt, actor, data }`), drops duplicates (seen `id` or `seq` ≤
   the stream cursor), keeps cursors per client stream (`user`, `views`, `tickets`,
   `ticket:{id}`, `conversation`) in memory + `sessionStorage` (`rx:rt:cursors:{ns}:{userId}`, `userId` option), on each
   (re)connect re-subscribes `ticket:*` streams then sends `sync` (envelopes arriving before the
   ack are buffered and applied in `seq` order), and invalidates keys for streams in
   `resyncRequired`. On `closing { code }` (`SESSION_REVOKED`, `SESSION_EXPIRED`,
   `TENANT_SUSPENDED`) it
   stops reconnecting and calls `onClosing` listeners (return to sign-in). Feature code:
   - `client.onEvent(type, (envelope, queryClient) => ...)` to patch/invalidate the cache
     (`'*'` = all); returns an unsubscribe.
   - `client.registerStreamKeys(prefix, (stream) => QueryKey[])` for resync invalidation
     (prefix = text before `:`, e.g. `ticket`, `tickets`).
   - `await client.subscribe('ticket:{id}')` (rejects with `NOT_FOUND` when not visible);
     `client.unsubscribe(stream)`.
   ```ts
   // target shape (src/data/tickets.ts)
   client.registerStreamKeys('tickets', () => [ticketKeys.all]);
   client.onEvent('access.revoked', (_envelope, queryClient) =>
     void queryClient.invalidateQueries({ queryKey: ticketKeys.all }));
   ```
   Tests inject `createSocket` with a fake (`test/data/socket.test.ts`).
   Wrong: `io()` in a component; listening for `'message.created'` as a socket event name;
   patching the cache without going through `onEvent` (skips dedupe)

8. **Customer hooks use only the customer API** (`customer` tag, `/customer/*`) and the
   `conversation` stream; they never import staff ticket hooks or keys.

## Checklist (before reporting done)
- [ ] Nothing under `src/api/generated` hand-edited; regenerated and committed after spec changes
- [ ] Components call `src/data` hooks only; each hook maps errors with `mapError`
- [ ] New resource has a key factory; mutations invalidate/patch it
- [ ] Live updates via `RealtimeClient.onEvent` + `registerStreamKeys`; no component sockets
- [ ] Customer hooks touch only customer endpoints and the `conversation` stream
