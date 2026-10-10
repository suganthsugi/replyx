---
name: cross-tenant-fixtures
description: test/cross-tenant/cross-tenant.test.ts auto-enumerates every route; a new mutating route with path params needs a body in test/cross-tenant/fixtures.ts or it 400s instead of 404ing
metadata:
  type: project
---

`apps/api/test/cross-tenant/cross-tenant.test.ts` generates one test per registered route from
`RouteAudit`. For a non-GET route with path params it calls the route with no body unless
`FIXTURES[resource].bodies[ControllerName.method]` supplies one, and asserts the response is 404
(same as a random id). If the route's body is required (a `.strict()` zod schema with required
fields), the missing body fails `ZodValidationPipe` first and the route 400s instead of reaching
the 404 lookup, failing the generated test.

**Why:** discovered adding `PUT /roles/:id` (T091): the existing `role` fixture in
`test/cross-tenant/fixtures.ts` only had a `create()`, no `bodies`, because until then `roles` had
no mutating routes with path params. The generated suite failed with "expected 400 to be 404" for
`PUT /roles/:id` the moment the route existed, even though the service itself returns 404 for an
unknown role id once a valid body reaches it.

Also: a brand-new permission resource (first segment of `@RequirePermission`, e.g. `dashboard`) needs a `FIXTURES` entry even for a parameterless GET: the test "has a fixture for every tenant-scoped route resource" and the per-route test fail with "No cross-tenant fixture for dashboard" (seen T225). Parameterless GETs are not skipped.

**How to apply:** `apps/api/test/` is out of backend-agent's owned paths — don't add the missing
`bodies` entry yourself. Flag it explicitly in the handback so test-automator adds
`bodies: { 'RolesController.update': (resource) => ({...}) }` (or equivalent) alongside the new
tests for the route. Don't read a red run of this generated suite as a bug in the new endpoint
without first checking whether its resource's fixture has a `bodies` entry for the new route name.
