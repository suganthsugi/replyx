import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RouteAudit, type RouteInfo } from '../../src/authorization/registry/route-audit.js';
import { getTestApp } from '../support/app.js';
import { createTenant, createUser, type TestUser } from '../support/factories.js';
import { asUser } from '../support/http.js';

import { ATTACHMENT_CHECKS, FIXTURES, REALTIME_CHECKS, type CreatedResource } from './fixtures.js';

/**
 * The generated cross-tenant suite (research D25, SC-010). Every tenant-scoped route of the
 * running app is called by a tenant B user who holds the route's permission, against a
 * resource created in tenant A:
 *
 * - routes with path parameters: 404, identical to the same call with random ids;
 * - lists (GET without parameters): 200 and no tenant A id anywhere in the body;
 * - creating routes without parameters create in the caller's own tenant: not applicable.
 *
 * Public, operator and health routes are not tenant-scoped resources and are skipped.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const routes = (await getTestApp()).app.get(RouteAudit).routes();

function resourceOf(route: RouteInfo): string | undefined {
  const access = route.access[0];
  if (route.access.length !== 1 || access === undefined) return undefined;
  if (access.kind === 'permission') return access.permission.split('.')[0];
  if (access.kind === 'customer') return `customer:${route.path.split('/')[2] ?? ''}`;
  return undefined;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:(\w+)/g)].map((match) => match[1] as string);
}

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Fixture has no value for path parameter :${name} in ${path}`);
    return value;
  });
}

const tenantRoutes = routes.filter((route) => resourceOf(route) !== undefined);

describe('cross-tenant isolation (generated)', () => {
  it('has a fixture for every tenant-scoped route resource', () => {
    const missing = [...new Set(tenantRoutes.map(resourceOf))].filter((resource) => FIXTURES[resource as string] === undefined);
    expect(missing, 'add these resources to test/cross-tenant/fixtures.ts').toEqual([]);
  });

  it('enumerates the routes of the running app', () => {
    // Health routes exist from Phase 2 on; the list grows with every story.
    expect(routes.map((route) => route.path)).toContain('/health/live');
  });

  for (const route of tenantRoutes) {
    const resource = resourceOf(route) as string;
    const params = pathParams(route.path);
    const method = route.method.toLowerCase() as Method;
    if (params.length === 0 && method !== 'get') continue;

    it(`${route.method} ${route.path} (${route.name}) hides tenant A's ${resource}`, async () => {
      const fixture = FIXTURES[resource];
      if (fixture === undefined) throw new Error(`No cross-tenant fixture for ${resource}`);
      const [a, b] = await Promise.all([createTenant(), createTenant()]);
      const created: CreatedResource = await fixture.create(a);
      const callerB: TestUser = await createUser(b, {
        roles: fixture.callerRoles ?? [resource.startsWith('customer:') ? 'customer' : 'admin'],
      });
      const body = fixture.bodies?.[route.name]?.(created);
      const call = (path: string) => asUser(callerB)[method](path, body);

      if (params.length === 0) {
        const response = await call(route.path);
        expect(response.status).toBe(200);
        const text = JSON.stringify(response.body);
        for (const id of created.ids) expect(text).not.toContain(id);
        return;
      }

      const cross = await call(fill(route.path, created.params));
      const random = await call(fill(route.path, Object.fromEntries(params.map((name) => [name, randomUUID()]))));
      expect(cross.status).toBe(404);
      expect(cross.body).toEqual(random.body);
    });
  }

  for (const [name, check] of Object.entries({ ...REALTIME_CHECKS, ...ATTACHMENT_CHECKS })) {
    it(`extra check: ${name}`, async () => {
      const [a, b] = await Promise.all([createTenant(), createTenant()]);
      await check(a, b, await createUser(b, { roles: ['admin'] }));
    });
  }
});
