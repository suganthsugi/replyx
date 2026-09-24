---
name: data-hooks
description: Wrapping the orval-generated client in apps/web/src/data — the http mutator, CSRF, error mapping, query keys, and socket cache updates. Use when adding hooks in apps/web/src/data or calling the API from a component.
---

# data-hooks

Scope: `apps/web/src/data` (the only layer allowed to touch `apps/web/src/api/generated`).
Loaded by frontend-connector. Ties to task T052 and
`specs/001-multi-tenant-helpdesk/contracts/README.md` (error format), `research.md` D8
(catch-up), D21 (frontend architecture), `orval.config.ts`.

## Rules

1. **Never edit `apps/web/src/api/generated/`.** It is orval output (`tags-split` mode, one file
   per OpenAPI tag under `src/api/generated/endpoints.ts` + `model/`). Regenerate it after any
   `apps/api/openapi.yaml` change with `bash scripts/generate-api-client.sh` (also runs
   automatically on backend-agent stop). Components and pages import hooks from `src/data`, never
   from `src/api/generated` directly (research D21).
   Wrong: hand-editing a generated hook to add a header or fix a type.

2. **The mutator is `http<T>(url, options): Promise<T>` in `src/data/http.ts`.** It sets
   `credentials: 'include'`, reads the `rx_csrf` cookie and sends it as `X-CSRF-Token` on every
   non-GET request, sends/parses JSON, and resolves to the parsed response body — not a
   `{data,status,headers}` wrapper, because `orval.config.ts` sets
   `override.fetch.includeHttpResponseReturnType: false` to match. On a non-2xx response it throws
   the parsed error envelope (rule 3), not a generic `Error`.
   ```ts
   // target shape (from orval.config.ts comment, tasks.md T052)
   // apps/web/src/data/http.ts
   export async function http<T>(url: string, options: RequestInit = {}): Promise<T> {
     const method = (options.method ?? 'GET').toUpperCase();
     const headers = new Headers(options.headers);
     if (method !== 'GET') {
       const csrf = readCookie('rx_csrf');
       if (csrf) headers.set('X-CSRF-Token', csrf);
     }
     if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
     const res = await fetch(url, { ...options, method, headers, credentials: 'include' });
     const body = res.status === 204 ? undefined : await res.json();
     if (!res.ok) throw body; // { error: { code, message, details? } }
     return body as T;
   }
   ```
   Wrong: reading the CSRF token from a JS-accessible global instead of the `rx_csrf` cookie, or
   returning `res.json()` unparsed on error so callers see a raw `Response`.

3. **Map the error envelope once, in `errors.ts`.** Every thrown value from `http` has the shape
   `{ error: { code, message, details?, retryAfter? } }` (`contracts/README.md`). `mapError`
   turns it into a typed `UiError { code, message, retryAfter?, fieldErrors? }` that components
   render; components never branch on the raw HTTP status. `429` carries `Retry-After`; surface it
   as `retryAfter` seconds. `code` values match the table in `contracts/README.md` (for example
   `PERMISSION_DENIED`, `VALIDATION_FAILED`, `TICKET_STATE_CONFLICT`, `RATE_LIMITED`).
   ```ts
   // apps/web/src/data/errors.ts (target shape)
   export function mapError(raw: unknown): UiError {
     if (isApiError(raw)) {
       return { code: raw.error.code, message: raw.error.message, fieldErrors: toFieldErrors(raw.error.details) };
     }
     return { code: 'NETWORK_ERROR', message: 'Could not reach the server.' };
   }
   ```
   Wrong: a component doing `if (err.status === 404)` — status codes are ambiguous (404 also
   means "not visible to you"; use `error.code` instead).

4. **Query keys are one hierarchy per resource, defined next to the hook that owns it**, so cache
   invalidation from `socket.ts` can target them without importing every feature module:
   `['tickets', 'list', filters]`, `['tickets', 'detail', id]`, `['customer', 'conversation']`.
   Don't inline ad-hoc arrays in components — import the key factory from `src/data`.
   Wrong: `useQuery({ queryKey: ['ticket-' + id], ... })` — string concatenation breaks partial
   invalidation (`queryClient.invalidateQueries({ queryKey: ['tickets'] })`).

5. **`socket.ts` owns the one Socket.IO connection per area** (`/` for staff, `/customer` for
   customers, path `/rt`) and applies events to the TanStack Query cache; no component opens its
   own socket. It stores the last `seq` per stream in memory and `sessionStorage`, sends
   `sync { streams: [{ stream, afterSeq }] }` on reconnect, drops any event whose `id` was already
   applied, and on `resync_required` calls `queryClient.invalidateQueries` for that stream's keys
   instead of trying to patch the cache (research D8). `access.revoked` navigates away from the
   affected screen and shows a toast (plan.md §Front-end state and real-time).
   ```ts
   // apps/web/src/data/socket.ts (target shape, research D8)
   socket.on('event', (evt: StreamEvent) => {
     if (hasApplied(evt.stream, evt.id)) return;
     markApplied(evt.stream, evt.id, evt.seq);
     applyToCache(queryClient, evt);
   });
   socket.on('resync_required', ({ stream }) => queryClient.invalidateQueries({ queryKey: keyFor(stream) }));
   ```
   Wrong: applying an event to the cache before checking `hasApplied`, which double-counts on
   reconnect replay.

6. **A feature hook wraps one generated hook and returns typed data plus `UiError`**, it doesn't
   re-export the generated hook as-is (that would leak the wrapper's job onto every call site).
   ```ts
   // apps/web/src/data/tickets.ts (target shape)
   export function useTicket(id: string) {
     const q = useGetTicket(id, { query: { queryKey: ticketKeys.detail(id) } }); // generated hook
     return { ...q, error: q.error ? mapError(q.error) : undefined };
   }
   ```

## Checklist (before reporting done)
- [ ] No file under `src/api/generated` was hand-edited; regenerated via
      `bash scripts/generate-api-client.sh` if the OpenAPI spec changed
- [ ] New endpoints are called through an `src/data` hook, not the generated hook directly
- [ ] Non-GET calls rely on `http.ts` for CSRF; no component reads `rx_csrf` itself
- [ ] Errors are mapped through `mapError`; no `error.status` branching in components
- [ ] Any new resource that needs live updates registers its query keys with `socket.ts`
