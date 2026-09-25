import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { service } from '../support/app.js';
import { createGroup, createRole, createUser, type RoleRef, type TestTenant, type TestUser } from '../support/factories.js';
import { connectResult } from '../support/socket.js';

/**
 * Cross-tenant fixtures (research D25, SC-010, testing-conventions rule 7). Every registry
 * resource that has a route needs one: the generated suite (cross-tenant.test.ts) creates the
 * resource in tenant A with `create`, then calls each of the resource's routes as a tenant B
 * user who holds the route's permission, and expects the same 404 as for an unknown id (lists:
 * no tenant A ids). A route whose resource has no fixture fails the suite.
 *
 * Staff routes are keyed by the registry resource (`ticket`, `group`, ...); customer routes
 * (`@CustomerApi`) by `customer:{first path segment after /customer}`, e.g. `customer:conversation`.
 * A route whose permission's resource differs from the resource in its path is keyed by its
 * route name (`Controller.method`), which wins over the resource key.
 */

export interface CreatedResource {
  /** Values for the route's path parameters, by name (`id`, `messageId`, ...). */
  params: Record<string, string>;
  /** Ids that must never appear in tenant B's responses. */
  ids: string[];
}

export interface CrossTenantFixture {
  /** Creates the resource (and anything it needs) in `tenant`. */
  create(tenant: TestTenant): Promise<CreatedResource>;
  /**
   * A valid request body per route name (`Controller.method`) for non-GET routes, so the
   * request reaches the service's lookup instead of failing validation.
   */
  bodies?: Record<string, (resource: CreatedResource) => object>;
  /** Roles for the tenant B caller; defaults to Admin (every permission, full group access). */
  callerRoles?: RoleRef[];
}

export const FIXTURES: Record<string, CrossTenantFixture> = {
  role: {
    async create(tenant) {
      const role = await createRole(tenant, { permissions: ['ticket.view'] });
      return { params: { id: role.id }, ids: [role.id] };
    },
    bodies: {
      'RolesController.update': () => ({ name: 'Renamed by another tenant', permissions: [], groupAccess: [] }),
    },
  },
  group: {
    async create(tenant) {
      const group = await createGroup(tenant);
      return { params: { id: group.id }, ids: [group.id] };
    },
    bodies: {
      'GroupsController.update': () => ({ name: 'Renamed by another tenant' }),
    },
  },
  // Keyed by route: the owner picker needs `ticket.edit` but its resource is a group (T095).
  'GroupsController.eligibleOwners': {
    async create(tenant) {
      const group = await createGroup(tenant);
      return { params: { id: group.id }, ids: [group.id] };
    },
  },
  user: {
    async create(tenant) {
      const user = await createUser(tenant, { roles: ['agent'] });
      return { params: { id: user.id }, ids: [user.id] };
    },
    bodies: {
      'UsersController.update': () => ({ name: 'Renamed by another tenant' }),
      'UsersController.erase': () => ({ confirm: 'ERASE' }),
    },
  },
  support_access: {
    async create(tenant) {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const id = await insertSupportGrant(tenant, admin.id);
      return { params: { id }, ids: [id] };
    },
  },
  // Settings have no routes yet (US2 covers the table); the fixture is ready for them (T085).
  tenant_settings: {
    async create(tenant) {
      return Promise.resolve({ params: {}, ids: [tenant.id] });
    },
  },
  'customer:me': {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      return { params: {}, ids: [customer.id] };
    },
  },
  'customer:auth': {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      return { params: {}, ids: [customer.id] };
    },
  },
};

/** A support-access grant for the fixture, written directly: the route needs an admin session. */
async function insertSupportGrant(tenant: TestTenant, grantedBy: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new GrantFixtureRepository(ctx).insert(tx, grantedBy));
}

class GrantFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, grantedBy: string): Promise<string> {
    const row = await this.insertInto(tx, 'support_access_grants', {
      granted_by: grantedBy,
      expires_at: new Date(Date.now() + 24 * 3_600_000),
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/**
 * Extra cross-tenant checks added by later stories: real-time subscriptions (a tenant B socket
 * subscribing to a tenant A stream acks NOT_FOUND) and attachment downloads.
 */
export type CrossTenantCheck = (a: TestTenant, b: TestTenant, callerB: TestUser) => Promise<void>;

export const REALTIME_CHECKS: Record<string, CrossTenantCheck> = {
  /** A tenant B user handshaking on tenant A's host is refused: the session is not A's (T085). */
  'socket handshake on another tenant host': async (a, _b, callerB) => {
    const { expect } = await import('vitest');
    expect(await connectResult(callerB, { host: a.host })).toBe('UNAUTHENTICATED');
  },
};
export const ATTACHMENT_CHECKS: Record<string, CrossTenantCheck> = {};
