import { issueDownloadToken } from '../../src/attachments/download.controller.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../support/app.js';
import { createGroup, createRole, createTicket, createUser, type RoleRef, type TestTenant, type TestUser } from '../support/factories.js';
import { asGuest, asUser } from '../support/http.js';
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
  ticket: {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, messages: [{ body: 'Hello from tenant A' }] });
      return { params: { id: ticket.id }, ids: [ticket.id] };
    },
    bodies: {
      'StaffMessagesController.post': () => ({
        visibility: 'public',
        body: 'Reply from another tenant',
        clientMessageId: uuidv7(),
      }),
    },
  },
  'customer:conversation': {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, messages: [{ body: 'Hello from tenant A' }] });
      return { params: {}, ids: [customer.id, ticket.id] };
    },
  },
  'customer:messages': {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      return { params: {}, ids: [customer.id] };
    },
    bodies: {
      'CustomerController.send': () => ({ body: 'Hello from another tenant', clientMessageId: uuidv7() }),
      'CustomerController.read': () => ({ upToMessageId: uuidv7() }),
    },
  },
  'customer:attachments': {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      const id = await insertAttachment(tenant, customer.id);
      return { params: { id }, ids: [id] };
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
 * A `clean`, unsent attachment (no message yet, visible only to its uploader) inserted directly:
 * the download checks never reach `FILE_STORAGE` for these fixtures (they 404 on the row lookup
 * or the tenant mismatch before a stream would start), so no bytes are written.
 */
async function insertAttachment(tenant: TestTenant, uploadedBy: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new AttachmentFixtureRepository(ctx).insert(tx, uploadedBy));
}

class AttachmentFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, uploadedBy: string): Promise<string> {
    const row = await this.insertInto(tx, 'attachments', {
      uploaded_by: uploadedBy,
      message_id: null,
      file_name: 'fixture.txt',
      content_type: 'text/plain',
      size_bytes: 10,
      storage_key: 'unused',
      scan_status: 'clean',
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
export const ATTACHMENT_CHECKS: Record<string, CrossTenantCheck> = {
  /** A tenant B staff user downloading a tenant A attachment is the same 404 as an unknown id. */
  'tenant B staff downloads a tenant A attachment': async (a, _b, callerB) => {
    const { expect } = await import('vitest');
    const uploader = await createUser(a, { roles: ['agent'] });
    const attachmentId = await insertAttachment(a, uploader.id);
    const response = await asUser(callerB).get(`/attachments/${attachmentId}/download`);
    expect(response.status).toBe(404);
  },
  /** A tenant A download token used on tenant B's host is the same 404: the tenant never matches. */
  'tenant A download token used on tenant B host': async (a, b, _callerB) => {
    const { expect } = await import('vitest');
    const uploader = await createUser(a, { roles: ['agent'] });
    const attachmentId = await insertAttachment(a, uploader.id);
    const clock = (await getTestApp()).clock;
    const token = issueDownloadToken({ t: a.id, a: attachmentId, e: clock.nowMs() + 60_000 });
    const response = await asGuest(b.host).get(`/files/${token}`);
    expect(response.status).toBe(404);
  },
};
