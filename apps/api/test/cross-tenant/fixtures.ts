import { issueDownloadToken } from '../../src/attachments/download.controller.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../support/app.js';
import { createCustomer } from '../support/customer-profiles.js';
import { createGroup, createRole, createTicket, createUser, type RoleRef, type TestTenant, type TestUser } from '../support/factories.js';
import { asGuest, asUser } from '../support/http.js';
import { createBusinessHours, createSlaPolicy } from '../support/sla.js';
import { connectResult, connectSocket } from '../support/socket.js';
import { createView } from '../support/view-factory.js';

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
  /**
   * A query string (without `?`) per GET route name, for routes that reject a bare call (`GET /search`
   * needs `q`). It must match the created resource: the generated suite also calls the route as a
   * tenant A admin and requires a created id in the body, so tenant B's empty answer is meaningful.
   */
  queries?: Record<string, (resource: CreatedResource) => string>;
  /** Roles for the tenant B caller; defaults to Admin (every permission, full group access). */
  callerRoles?: RoleRef[];
}

const HIGH_PRIORITY = { op: 'and', items: [{ field: 'priority', operator: 'is', value: 'high' }] };

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
  // One entry for both controllers: business-hours and SLA policies share the `sla_policy` permissions (T224).
  sla_policy: {
    async create(tenant) {
      const hours = await createBusinessHours(tenant, { intervals: { mon: [{ from: '09:00', to: '17:00' }] } });
      const policy = await createSlaPolicy(tenant, { businessHours: hours, conditions: HIGH_PRIORITY, firstResponseMinutes: 60 });
      return { params: { id: policy.id }, ids: [hours.id, policy.id] };
    },
    bodies: {
      'BusinessHoursController.update': () => ({
        name: 'Renamed by another tenant',
        timezone: 'UTC',
        intervals: { mon: [{ from: '09:00', to: '17:00' }] },
        holidays: [],
      }),
      'SlaPoliciesController.update': (resource) => ({
        name: 'Renamed by another tenant',
        conditions: HIGH_PRIORITY,
        businessHoursId: resource.ids[0],
        warningPercent: 80,
      }),
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
  audit_log: {
    async create(tenant) {
      const id = await insertAuditEntry(tenant);
      return { params: {}, ids: [id] };
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
  // AI settings are one row per tenant: tenant B's admin must see its own defaults, never A's
  // mode or key (the id is A's distinctive last4; the model catalog is the same for everyone).
  ai_settings: {
    async create(tenant) {
      const admin = await createUser(tenant, { roles: ['admin'] });
      await asUser(admin).put('/ai/settings/provider-key', { apiKey: 'sk-or-v1-tenant-a-ZQXW' });
      await asUser(admin).patch('/ai/settings', { replyMode: 'auto', models: { fast: 'qwen/qwen3.7-flash' } });
      return { params: {}, ids: ['ZQXW'] };
    },
  },
  // Policy documents (T016): tenant B must get the unknown-id 404 for A's document on every
  // `/ai/policies/{id}` route and no A id in the list. The bodies are valid, so the request reaches
  // the tenant-scoped lookup instead of failing validation.
  ai_knowledge: {
    async create(tenant) {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const response = await asUser(admin).post('/ai/policies', { title: `Returns policy ${tenant.slug}`, text: 'Items can be returned within 30 days.' });
      const id = (response.body as { id: string }).id;
      return { params: { id }, ids: [id] };
    },
    bodies: {
      'AiPoliciesController.rename': () => ({ title: 'Renamed by another tenant' }),
      'AiPoliciesController.createVersion': () => ({ text: 'New text from another tenant' }),
    },
  },
  routing_rule: {
    async create(tenant) {
      const group = await createGroup(tenant);
      const id = await insertRoutingRule(tenant, group.id);
      return { params: { id }, ids: [id, group.id] };
    },
    bodies: {
      // RoutingRuleInput must validate before the tenant-scoped lookup 404s.
      'RoutingRulesController.update': () => ({
        name: 'Renamed by another tenant',
        enabled: false,
        conditions: { messageContainsAny: ['refund'] },
        actions: { groupId: uuidv7() },
      }),
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
      const target = await createTicket(tenant, { customer, messages: [{ body: 'Target ticket from tenant A' }] });
      const { linkId, messageId } = await insertLinkAndMessageId(tenant, ticket.id, target.id);
      return { params: { id: ticket.id, linkId, messageId }, ids: [ticket.id, target.id] };
    },
    bodies: {
      'StaffMessagesController.post': () => ({
        visibility: 'public',
        body: 'Reply from another tenant',
        clientMessageId: uuidv7(),
      }),
      'TicketsController.update': () => ({ title: 'Renamed by another tenant' }),
      'TicketLinksController.create': (resource) => ({ targetTicketId: resource.ids[1] ?? uuidv7(), kind: 'related' }),
      'TicketsController.moveMessage': (resource) => ({ targetTicketId: resource.ids[1] ?? uuidv7() }),
      // Zod requires groupId before the tenant-scoped lookup runs; a well-formed but unrelated id
      // is enough since the ticket lookup 404s first either way (tenant B, or an unknown id).
      'TicketsController.triage': () => ({ groupId: uuidv7() }),
      // The ticket lookup 404s before the macro is looked up (T236).
      'MacroApplyController.apply': () => ({ macroId: uuidv7(), clientMessageId: uuidv7() }),
      // The source ticket lookup 404s first (T237), so the body only has to validate.
      'TicketsController.merge': (resource) => ({ targetTicketId: resource.ids[1] ?? uuidv7() }),
      'TicketsController.split': () => ({ messageId: uuidv7() }),
    },
    // Both fixture messages contain "tenant", so tenant A's own search finds them (T232).
    queries: { 'SearchController.find': () => 'q=tenant&type=all' },
  },
  tag: {
    async create(tenant) {
      const id = await insertTag(tenant, `Tag ${uuidv7()}`);
      return { params: { id }, ids: [id] };
    },
    bodies: {
      'TagsController.update': () => ({ name: 'Renamed by another tenant' }),
    },
  },
  macro: {
    async create(tenant) {
      const id = await insertMacro(tenant, 'Tenant A macro');
      return { params: { id }, ids: [id] };
    },
    bodies: {
      // MacroInput must validate before the tenant-scoped lookup 404s (POST /macros has no path id).
      'MacrosController.update': () => ({ name: 'Renamed by another tenant', body: 'Hello', actions: { priority: 'high' }, visibility: 'all_staff' }),
    },
  },
  view: {
    async create(tenant) {
      const view = await createView(tenant, { name: 'Tenant A view' });
      return { params: { id: view.id }, ids: [view.id] };
    },
    bodies: {
      // ViewInput must validate before the tenant-scoped lookup 404s (POST /views and
      // POST /views/preview-count have no path id, so the generated suite skips them).
      'ViewsController.update': () => ({
        name: 'Renamed by another tenant',
        visibility: 'personal',
        conditions: { op: 'and', items: [{ field: 'state', operator: 'is_not', value: 'closed' }] },
        sort: [{ field: 'updated_at', direction: 'desc' }],
        columns: ['number', 'title', 'state', 'updated_at'],
      }),
    },
  },
  // Keyed by route: getCustomer/updateCustomer need `user.view`/`user.edit` (the resource is the
  // registry key `user`, shared with UsersController), but the fixture needs a real customer (a
  // `customer_profiles` row), not the plain staff `user` fixture's user.
  'CustomersController.get': {
    async create(tenant) {
      const customer = await createCustomer(tenant);
      return { params: { id: customer.id }, ids: [customer.id] };
    },
  },
  'CustomersController.update': {
    async create(tenant) {
      const customer = await createCustomer(tenant);
      return { params: { id: customer.id }, ids: [customer.id] };
    },
    bodies: {
      'CustomersController.update': () => ({ name: 'Renamed by another tenant' }),
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
  // `@StaffApi()` (own account only, no permission key): GET /notifications and
  // GET /notification-preferences are lists/reads with no path parameter, so the generated suite
  // checks tenant B's own (empty) view never contains tenant A's id. POST /notifications/read
  // takes ids in the body, not a path parameter, so it needs its own hand-written cross-tenant
  // check (test/integration/notifications/notifications.test.ts, T167).
  notification: {
    async create(tenant) {
      const recipient = await createUser(tenant, { roles: ['admin'] });
      const id = await insertNotification(tenant, recipient.id);
      return { params: {}, ids: [id] };
    },
  },
  // `GET /dashboard` is a read with no path parameter: tenant B's 200 body must hold zero counts and
  // none of tenant A's ids (T226). The fixture gives A a group and an open ticket to be counted.
  dashboard: {
    async create(tenant) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      const group = await createGroup(tenant);
      const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open', messages: [{ body: 'Dashboard ticket from tenant A' }] });
      return { params: {}, ids: [group.id, ticket.id, customer.id] };
    },
  },
};

/** A tenant's notification row, inserted directly (no event needed: event_id has no FK, T167). */
async function insertNotification(tenant: TestTenant, recipientId: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new NotificationFixtureRepository(ctx).insert(tx, recipientId));
}

class NotificationFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, recipientId: string): Promise<string> {
    const row = await this.insertInto(tx, 'notifications', {
      recipient_id: recipientId,
      event_type: 'mention',
      ticket_id: null,
      group_key: null,
      title: 'Fixture notification',
      summary: null,
      event_id: uuidv7(),
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/** An audit entry for the fixture; the app role may insert but never update or delete it. */
async function insertAuditEntry(tenant: TestTenant): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new AuditFixtureRepository(ctx).insert(tx));
}

class AuditFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction): Promise<string> {
    const row = await this.insertInto(tx, 'audit_logs', {
      actor_kind: 'system',
      actor_id: null,
      action: 'ticket.assigned',
      resource_type: 'ticket',
      resource_id: uuidv7(),
      details: '{}',
      ip: null,
      request_id: 'cross-tenant-fixture',
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

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

/** A tenant's routing rule, inserted directly (position 0, targeting `groupId`). */
async function insertRoutingRule(tenant: TestTenant, groupId: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new RoutingRuleFixtureRepository(ctx).insert(tx, groupId));
}

class RoutingRuleFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, groupId: string): Promise<string> {
    const row = await this.insertInto(tx, 'routing_rules', {
      name: 'Tenant A rule',
      enabled: true,
      position: 0,
      conditions: JSON.stringify({ messageContainsAny: ['refund'] }),
      actions: JSON.stringify({ groupId }),
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/** A tenant's macro, inserted directly (shared with all staff, no actions). */
async function insertMacro(tenant: TestTenant, name: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new MacroFixtureRepository(ctx).insert(tx, name));
}

class MacroFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, name: string): Promise<string> {
    const row = await this.insertInto(tx, 'macros', { name, body: 'Hello from tenant A', actions: '{}', created_by: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/** A tenant's tag, inserted directly (no create-tag call needed for the fixture). */
async function insertTag(tenant: TestTenant, name: string): Promise<string> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  return unitOfWork.withTenant(ctx, (tx) => new TagFixtureRepository(ctx).insert(tx, name));
}

class TagFixtureRepository extends TenantRepository {
  async insert(tx: TenantTransaction, name: string): Promise<string> {
    const row = await this.insertInto(tx, 'tags', { name }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }
}

/**
 * A link between the ticket fixture's two tickets, plus the id of the source ticket's first
 * message, so `/tickets/{id}/links/{linkId}` and `/tickets/{id}/messages/{messageId}/move` have
 * real path parameters. The tenant mismatch is caught on the source ticket lookup before either
 * id is used, so neither needs to resolve to anything for the cross-tenant 404 to match.
 */
async function insertLinkAndMessageId(tenant: TestTenant, ticketId: string, targetTicketId: string): Promise<{ linkId: string; messageId: string }> {
  const unitOfWork = await service(UnitOfWork);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'cross-tenant-fixture' });
  const repo = new TicketFixtureRepository(ctx);
  return unitOfWork.withTenant(ctx, async (tx) => ({
    linkId: await repo.insertLink(tx, ticketId, targetTicketId),
    messageId: await repo.firstMessageId(tx, ticketId),
  }));
}

class TicketFixtureRepository extends TenantRepository {
  async insertLink(tx: TenantTransaction, fromTicketId: string, toTicketId: string): Promise<string> {
    const row = await this.insertInto(tx, 'ticket_links', {
      from_ticket_id: fromTicketId,
      to_ticket_id: toTicketId,
      kind: 'related',
      created_by: null,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async firstMessageId(tx: TenantTransaction, ticketId: string): Promise<string> {
    const row = await this.selectFrom(tx, 'ticket_messages').where('ticket_id', '=', ticketId).select('id').executeTakeFirstOrThrow();
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
  /** A tenant B socket, connected on its own host, may not subscribe to a tenant A ticket room (US6). */
  'socket subscribes to another tenant’s ticket room': async (a, _b, callerB) => {
    const { expect } = await import('vitest');
    const customer = await createUser(a, { roles: ['customer'] });
    const ticket = await createTicket(a, { customer, messages: [{ body: 'Hello from tenant A' }] });
    const socket = await connectSocket(callerB);
    try {
      expect(await socket.emitWithAck('subscribe', { stream: `ticket:${ticket.id}` })).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    } finally {
      socket.close();
    }
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
