import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * T239 (US14): macros, merge and split. This file is shared: the `macros` block covers
 * `/macros` CRUD and `POST /tickets/{id}/apply-macro` (T236, FR-068); merge, split and bulk
 * blocks are added as sibling `describe`s.
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });
const failure = (response: { body: unknown }) => response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

interface MacroBody {
  id: string;
  name: string;
  body: string;
  actions: Record<string, unknown>;
  visibility: string;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
}
interface TicketBody {
  id: string;
  state: string;
  priority: string;
  owner: { id: string } | null;
  tags: { id: string; name: string }[];
}

class Inspect extends TenantRepository {
  messages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['body', 'visibility', 'author_kind']).where('ticket_id', '=', ticketId).orderBy('id').execute();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history').select(['field', 'old_value', 'new_value', 'actor_id']).where('ticket_id', '=', ticketId).execute();
  }

  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['state', 'priority', 'owner_id', 'pending_until']).where('id', '=', ticketId).executeTakeFirstOrThrow();
  }

  events(tx: TenantTransaction, ticketId: string, type: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select(['type', 'streams'])
      .where('type', '=', type)
      .where(sql<boolean>`streams::text LIKE ${`%${ticketId}%`}`)
      .execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'macros-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string, code: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
  expect(failure(cross).error.code).toBe(code);
}

const macroInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Thanks',
  body: 'Thanks for writing in.',
  actions: {},
  visibility: 'all_staff',
  ...overrides,
});

const MACRO_PERMISSIONS = ['macro.view', 'macro.create', 'macro.edit', 'macro.delete'];

async function staffWithRole(tenant: TestTenant, permissions: string[], groups: { group: string | null; flags: { view?: boolean; edit?: boolean } }[] = []): Promise<TestUser> {
  const role = await createRole(tenant, { permissions, groups });
  return createUser(tenant, { roles: [{ id: role.id }] });
}

async function createMacro(user: TestUser, overrides: Record<string, unknown> = {}): Promise<MacroBody> {
  const response = await asUser(user).post('/macros', macroInput(overrides));
  expect(response.status).toBe(201);
  return response.body as MacroBody;
}

beforeAll(async () => {
  await getTestApp();
});

describe('macros', () => {
  describe('CRUD', () => {
    it('lists, creates, updates and deletes with the macro permissions (success)', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });

      const created = await asUser(admin).post('/macros', macroInput({ actions: { priority: 'high', assignToMe: false, addTagIds: [] } }));
      expect(created.status).toBe(201);
      const macro = created.body as MacroBody;
      expect(macro).toMatchObject({
        name: 'Thanks',
        body: 'Thanks for writing in.',
        actions: { priority: 'high' },
        visibility: 'all_staff',
        sharedRoleIds: [],
        sharedGroupIds: [],
      });

      const list = await asUser(admin).get('/macros');
      expect(list.status).toBe(200);
      expect((list.body as { items: MacroBody[] }).items.map((m) => m.id)).toEqual([macro.id]);

      const updated = await asUser(admin).put(`/macros/${macro.id}`, macroInput({ name: 'Renamed', actions: { state: 'resolved' } }));
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ id: macro.id, name: 'Renamed', actions: { state: 'resolved' } });

      const deleted = await asUser(admin).delete(`/macros/${macro.id}`);
      expect(deleted.status).toBe(204);
      expect(((await asUser(admin).get('/macros')).body as { items: unknown[] }).items).toEqual([]);
    });

    it('is 403 PERMISSION_DENIED for staff without the matching permission', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const macro = await createMacro(admin);
      const agent = await createUser(tenant, { roles: ['agent'] });
      const noMacros = await staffWithRole(tenant, ['ticket.view']);

      expect((await asUser(agent).get('/macros')).status).toBe(200);
      for (const response of [
        await asUser(noMacros).get('/macros'),
        await asUser(agent).post('/macros', macroInput()),
        await asUser(agent).put(`/macros/${macro.id}`, macroInput()),
        await asUser(agent).delete(`/macros/${macro.id}`),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
      }
    });

    it("is 404 MACRO_NOT_FOUND for another tenant's macro, equal to an unknown id, and lists never include it", async () => {
      const [a, b] = [await createTenant(), await createTenant()];
      const adminA = await createUser(a, { roles: ['admin'] });
      const adminB = await createUser(b, { roles: ['admin'] });
      const macro = await createMacro(adminA);

      await expectCrossTenant404((id) => asUser(adminB).put(`/macros/${id}`, macroInput()), macro.id, 'MACRO_NOT_FOUND');
      await expectCrossTenant404((id) => asUser(adminB).delete(`/macros/${id}`), macro.id, 'MACRO_NOT_FOUND');
      expect(((await asUser(adminB).get('/macros')).body as { items: unknown[] }).items).toEqual([]);
      // Tenant A still has it.
      expect(((await asUser(adminA).get('/macros')).body as { items: unknown[] }).items).toHaveLength(1);
    });
  });

  describe('visibility', () => {
    it('shows all_staff macros to every staff member with macro.view', async () => {
      const tenant = await createTenant();
      const creator = await staffWithRole(tenant, MACRO_PERMISSIONS);
      const agent = await createUser(tenant, { roles: ['agent'] });
      const macro = await createMacro(creator);
      const items = ((await asUser(agent).get('/macros')).body as { items: MacroBody[] }).items;
      expect(items.map((m) => m.id)).toEqual([macro.id]);
    });

    it('shows a roles macro to holders of the shared role and the creator only; others get 404 MACRO_NOT_FOUND', async () => {
      const tenant = await createTenant();
      const sharedRole = await createRole(tenant, { permissions: ['macro.view', 'macro.edit', 'macro.delete'] });
      const holder = await createUser(tenant, { roles: [{ id: sharedRole.id }] });
      const creator = await staffWithRole(tenant, MACRO_PERMISSIONS);
      const other = await staffWithRole(tenant, MACRO_PERMISSIONS);
      const macro = await createMacro(creator, { visibility: 'roles', sharedRoleIds: [sharedRole.id] });
      expect(macro).toMatchObject({ visibility: 'roles', sharedRoleIds: [sharedRole.id], sharedGroupIds: [] });

      const ids = async (user: TestUser) => ((await asUser(user).get('/macros')).body as { items: MacroBody[] }).items.map((m) => m.id);
      expect(await ids(holder)).toEqual([macro.id]);
      expect(await ids(creator)).toEqual([macro.id]);
      expect(await ids(other)).toEqual([]);

      const hidden = await asUser(other).put(`/macros/${macro.id}`, macroInput());
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(errorBody('MACRO_NOT_FOUND'));
      expect((await asUser(holder).put(`/macros/${macro.id}`, macroInput({ visibility: 'roles', sharedRoleIds: [sharedRole.id] }))).status).toBe(200);
    });

    it('shows a groups macro to users with view access on a shared group; others get 404', async () => {
      const tenant = await createTenant();
      const group = await createGroup(tenant);
      const otherGroup = await createGroup(tenant);
      const member = await staffWithRole(tenant, ['macro.view', 'macro.delete'], [{ group: group.id, flags: { view: true } }]);
      const outsider = await staffWithRole(tenant, ['macro.view', 'macro.delete'], [{ group: otherGroup.id, flags: { view: true } }]);
      const creator = await staffWithRole(tenant, MACRO_PERMISSIONS);
      const macro = await createMacro(creator, { visibility: 'groups', sharedGroupIds: [group.id] });

      const ids = async (user: TestUser) => ((await asUser(user).get('/macros')).body as { items: MacroBody[] }).items.map((m) => m.id);
      expect(await ids(member)).toEqual([macro.id]);
      expect(await ids(outsider)).toEqual([]);
      expect(await ids(creator)).toEqual([macro.id]);

      const hidden = await asUser(outsider).delete(`/macros/${macro.id}`);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(errorBody('MACRO_NOT_FOUND'));
      expect((await asUser(member).delete(`/macros/${macro.id}`)).status).toBe(204);
    });

    it('rejects roles or groups from another tenant and visibilities without ids', async () => {
      const [a, b] = [await createTenant(), await createTenant()];
      const admin = await createUser(a, { roles: ['admin'] });
      const foreignGroup = await createGroup(b);

      const foreign = await asUser(admin).post('/macros', macroInput({ visibility: 'groups', sharedGroupIds: [foreignGroup.id] }));
      expect(foreign.status).toBe(400);
      expect(failure(foreign).error.details).toEqual([{ path: 'sharedGroupIds.0', issue: 'invalid_value' }]);

      const empty = await asUser(admin).post('/macros', macroInput({ visibility: 'roles' }));
      expect(empty.status).toBe(400);
      expect(failure(empty).error.details).toEqual([{ path: 'sharedRoleIds', issue: 'too_few' }]);
    });
  });

  describe('validation', () => {
    it('enforces the name and body limits', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const post = (overrides: Record<string, unknown>) => asUser(admin).post('/macros', macroInput(overrides));

      for (const response of [await post({ name: '' }), await post({ name: 'x'.repeat(81) }), await post({ body: 'x'.repeat(10_001) })]) {
        expect(response.status).toBe(400);
        expect(response.body).toEqual(errorBody('VALIDATION_FAILED'));
      }
      expect((await post({ name: 'x'.repeat(80) })).status).toBe(201);
      expect((await post({ name: 'Max body', body: 'x'.repeat(10_000) })).status).toBe(201);
    });

    it('requires pendingInHours with a pending state, and only then', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const post = (actions: Record<string, unknown>) => asUser(admin).post('/macros', macroInput({ actions }));

      const missing = await post({ state: 'pending_reminder' });
      expect(missing.status).toBe(400);
      expect(failure(missing).error.details).toContainEqual({ path: 'actions.pendingInHours', issue: 'required' });
      const stray = await post({ state: 'open', pendingInHours: 2 });
      expect(stray.status).toBe(400);
      expect(failure(stray).error.details).toContainEqual({ path: 'actions.pendingInHours', issue: 'invalid' });
      const ok = await post({ state: 'pending_close', pendingInHours: 48 });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ actions: { state: 'pending_close', pendingInHours: 48 } });
    });

    it('rejects an empty macro (no body and no actions) but accepts a fields-only macro', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const empty = await asUser(admin).post('/macros', macroInput({ body: '   ', actions: {} }));
      expect(empty.status).toBe(400);
      expect(failure(empty).error.details).toContainEqual({ path: 'body', issue: 'required' });
      expect((await asUser(admin).post('/macros', macroInput({ body: '', actions: { priority: 'low' } }))).status).toBe(201);
    });

    it('rejects unknown tag ids in actions', async () => {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const response = await asUser(admin).post('/macros', macroInput({ actions: { addTagIds: [uuidv7()] } }));
      expect(response.status).toBe(400);
      expect(failure(response).error.details).toEqual([{ path: 'actions.addTagIds.0', issue: 'invalid_value' }]);
    });
  });

  describe('POST /tickets/{id}/apply-macro', () => {
    async function setup() {
      const tenant = await createTenant();
      const admin = await createUser(tenant, { roles: ['admin'] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });
      return { tenant, admin, customer, ticket };
    }
    const apply = (user: TestUser, ticketId: string, macroId: string, extra: Record<string, unknown> = {}) =>
      asUser(user).post(`/tickets/${ticketId}/apply-macro`, { macroId, clientMessageId: uuidv7(), ...extra });

    it('inserts the reply and applies state, priority, tags and owner in one transaction, with history and events', async () => {
      const { tenant, admin, ticket } = await setup();
      const tag = (await asUser(admin).post('/tags', { name: 'Billing' })).body as { id: string };
      const macro = await createMacro(admin, {
        body: 'We are on it.',
        actions: { state: 'pending_reminder', pendingInHours: 4, priority: 'urgent', addTagIds: [tag.id], assignToMe: true },
      });
      const clock = (await getTestApp()).clock;

      const response = await apply(admin, ticket.id, macro.id);
      expect(response.status).toBe(200);
      const result = response.body as TicketBody;
      expect(result).toMatchObject({ id: ticket.id, state: 'pending_reminder', priority: 'urgent', owner: { id: admin.id } });
      expect(result.tags.map((t) => t.id)).toEqual([tag.id]);

      const { messages, history, row, updated, created } = await inspect(tenant, async (tx, repo) => ({
        messages: await repo.messages(tx, ticket.id),
        history: await repo.history(tx, ticket.id),
        row: await repo.ticket(tx, ticket.id),
        updated: await repo.events(tx, ticket.id, 'ticket.updated'),
        created: await repo.events(tx, ticket.id, 'message.created'),
      }));
      expect(messages).toEqual([{ body: 'We are on it.', visibility: 'public', author_kind: 'staff' }]);
      expect(row.state).toBe('pending_reminder');
      expect(row.pending_until?.getTime()).toBe(clock.now().getTime() + 4 * 3_600_000);
      const fields = history.map((h) => h.field);
      expect(fields).toEqual(expect.arrayContaining(['state', 'priority', 'owner_id']));
      expect(history.every((h) => h.actor_id === admin.id)).toBe(true);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(updated.length).toBeGreaterThanOrEqual(1);
    });

    it('uses bodyOverride for the reply, and a fields-only macro creates no message', async () => {
      const { tenant, admin, ticket } = await setup();
      const withBody = await createMacro(admin, { body: 'Original', actions: { priority: 'high' } });
      expect((await apply(admin, ticket.id, withBody.id, { bodyOverride: 'Edited reply' })).status).toBe(200);
      const fieldsOnly = await createMacro(admin, { name: 'Fields', body: '', actions: { priority: 'low' } });
      const second = await apply(admin, ticket.id, fieldsOnly.id);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ priority: 'low' });
      const messages = await inspect(tenant, (tx, repo) => repo.messages(tx, ticket.id));
      expect(messages.map((m) => m.body)).toEqual(['Edited reply']);
    });

    it('rolls the reply back when a field change fails (INVALID_TRANSITION on a closed ticket)', async () => {
      const { tenant, admin, customer } = await setup();
      const closed = await createTicket(tenant, { customer, group: null, state: 'closed' });
      const macro = await createMacro(admin, { body: 'Reopening', actions: { state: 'resolved', priority: 'high' } });

      const response = await apply(admin, closed.id, macro.id);
      expect(response.status).toBe(409);
      expect(failure(response).error.code).toBe('INVALID_TRANSITION');

      const { messages, history, row } = await inspect(tenant, async (tx, repo) => ({
        messages: await repo.messages(tx, closed.id),
        history: await repo.history(tx, closed.id),
        row: await repo.ticket(tx, closed.id),
      }));
      expect(messages).toEqual([]);
      expect(history).toEqual([]);
      expect(row).toMatchObject({ state: 'closed', priority: 'normal' });
      expect(await inspect(tenant, (tx, repo) => repo.events(tx, closed.id, 'message.created'))).toEqual([]);
    });

    it('applies nothing twice when retried with the same clientMessageId', async () => {
      const { tenant, admin, ticket } = await setup();
      const macro = await createMacro(admin, { body: 'Once only', actions: { priority: 'high', assignToMe: true } });
      const payload = { macroId: macro.id, clientMessageId: uuidv7() };

      const first = await asUser(admin).post(`/tickets/${ticket.id}/apply-macro`, payload);
      expect(first.status).toBe(200);
      const snapshot = await inspect(tenant, async (tx, repo) => ({
        messages: await repo.messages(tx, ticket.id),
        history: await repo.history(tx, ticket.id),
        updated: await repo.events(tx, ticket.id, 'ticket.updated'),
        created: await repo.events(tx, ticket.id, 'message.created'),
      }));
      const retry = await asUser(admin).post(`/tickets/${ticket.id}/apply-macro`, payload);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id: ticket.id, priority: 'high', owner: { id: admin.id } });
      const after = await inspect(tenant, async (tx, repo) => ({
        messages: await repo.messages(tx, ticket.id),
        history: await repo.history(tx, ticket.id),
        updated: await repo.events(tx, ticket.id, 'ticket.updated'),
        created: await repo.events(tx, ticket.id, 'message.created'),
      }));
      expect(snapshot.messages).toHaveLength(1);
      expect(after).toEqual(snapshot);
    });

    it('skips a tag that was deleted after the macro was saved', async () => {
      const { admin, ticket } = await setup();
      const kept = (await asUser(admin).post('/tags', { name: 'Kept' })).body as { id: string };
      const gone = (await asUser(admin).post('/tags', { name: 'Gone' })).body as { id: string };
      const macro = await createMacro(admin, { actions: { addTagIds: [kept.id, gone.id], priority: 'high' } });
      expect((await asUser(admin).delete(`/tags/${gone.id}`)).status).toBe(204);

      const response = await apply(admin, ticket.id, macro.id);
      expect(response.status).toBe(200);
      expect((response.body as TicketBody).tags.map((t) => t.id)).toEqual([kept.id]);
      expect(response.body).toMatchObject({ priority: 'high' });
    });

    it('is 403 without ticket.edit on the ticket group or without macro.view, and 404 when the ticket is not visible', async () => {
      const { tenant, admin, customer } = await setup();
      const group = await createGroup(tenant);
      const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
      const macro = await createMacro(admin);

      const viewOnly = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'macro.view'], [{ group: group.id, flags: { view: true, edit: false } }]);
      const denied = await apply(viewOnly, ticket.id, macro.id);
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

      const noMacroView = await staffWithRole(tenant, ['ticket.view', 'ticket.edit'], [{ group: group.id, flags: { view: true, edit: true } }]);
      const noMacro = await apply(noMacroView, ticket.id, macro.id);
      expect(noMacro.status).toBe(403);
      expect(noMacro.body).toEqual(errorBody('PERMISSION_DENIED'));

      const noTicketEdit = await staffWithRole(tenant, ['ticket.view', 'macro.view'], [{ group: group.id, flags: { view: true, edit: true } }]);
      expect((await apply(noTicketEdit, ticket.id, macro.id)).status).toBe(403);

      const invisible = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'macro.view']);
      const hidden = await apply(invisible, ticket.id, macro.id);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(errorBody('TICKET_NOT_FOUND'));

      const allowed = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'macro.view'], [{ group: group.id, flags: { view: true, edit: true } }]);
      expect((await apply(allowed, ticket.id, macro.id)).status).toBe(200);
    });

    it('is 404 MACRO_NOT_FOUND for a macro the caller cannot see, and 404 for another tenant\'s ticket', async () => {
      const { tenant, admin, ticket } = await setup();
      const sharedRole = await createRole(tenant, { permissions: ['macro.view'] });
      const macro = await createMacro(admin, { visibility: 'roles', sharedRoleIds: [sharedRole.id] });
      const caller = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'macro.view'], [{ group: null, flags: { view: true, edit: true } }]);
      const hidden = await apply(caller, ticket.id, macro.id);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(errorBody('MACRO_NOT_FOUND'));
      expect((await apply(caller, ticket.id, uuidv7())).body).toEqual(hidden.body);

      const other = await createTenant();
      const otherAdmin = await createUser(other, { roles: ['admin'] });
      const ownMacro = await createMacro(otherAdmin);
      await expectCrossTenant404((id) => apply(otherAdmin, id, ownMacro.id), ticket.id, 'TICKET_NOT_FOUND');
      // Tenant A's macro through tenant B is unknown to B too.
      const foreignMacro = await apply(otherAdmin, (await createTicket(other, { customer: await createUser(other, { roles: ['customer'] }), state: 'open' })).id, macro.id);
      expect(foreignMacro.status).toBe(404);
      expect(failure(foreignMacro).error.code).toBe('MACRO_NOT_FOUND');
    });

    it('validates the request body', async () => {
      const { admin, ticket } = await setup();
      const response = await asUser(admin).post(`/tickets/${ticket.id}/apply-macro`, { macroId: 'nope', clientMessageId: uuidv7() });
      expect(response.status).toBe(400);
      expect(response.body).toEqual(errorBody('VALIDATION_FAILED'));
    });
  });
});

interface MessageItem {
  id: string;
  body: string;
}
const bodies = (response: { body: unknown }) => (response.body as { items: MessageItem[] }).items.map((item) => item.body);

class MergeInspect extends TenantRepository {
  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['state', 'merged_into_id', 'origin', 'customer_id']).where('id', '=', ticketId).executeTakeFirstOrThrow();
  }

  links(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_links').select(['from_ticket_id', 'to_ticket_id', 'kind']).where('from_ticket_id', '=', ticketId).execute();
  }

  messageCount(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'ticket_messages')
      .innerJoin('tickets', (join) => join.onRef('tickets.tenant_id', '=', 'ticket_messages.tenant_id').onRef('tickets.id', '=', 'ticket_messages.ticket_id'))
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tickets.customer_id', '=', customerId)
      .executeTakeFirstOrThrow();
  }

  messageTicket(tx: TenantTransaction, body: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['id', 'ticket_id']).where('body', '=', body).executeTakeFirstOrThrow();
  }
}

async function inspectMerge<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: MergeInspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'merge-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new MergeInspect(ctx)));
}

describe('POST /tickets/{id}/merge', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  beforeAll(async () => {
    tenant = await createTenant();
    admin = await createUser(tenant, { roles: ['admin'] });
  });

  it('closes the source with merged_into, links it, and shows its messages once in the target timeline and the customer thread (success)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'merge-src-1' }] });
    const target = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'merge-tgt-1' }] });
    const before = await inspectMerge(tenant, (tx, repo) => repo.messageCount(tx, customer.id));

    const response = await asUser(admin).post(`/tickets/${source.id}/merge`, { targetTicketId: target.id });
    expect(response.status).toBe(200);
    expect((response.body as TicketBody).id).toBe(target.id);

    expect(await inspectMerge(tenant, (tx, repo) => repo.ticket(tx, source.id))).toMatchObject({ state: 'closed', merged_into_id: target.id });
    expect(await inspectMerge(tenant, (tx, repo) => repo.links(tx, source.id))).toEqual([{ from_ticket_id: source.id, to_ticket_id: target.id, kind: 'merged_into' }]);

    const timeline = bodies(await asUser(admin).get(`/tickets/${target.id}/messages`));
    expect(timeline.filter((body) => body === 'merge-src-1')).toHaveLength(1);
    expect(timeline).toContain('merge-tgt-1');
    // Nothing is copied.
    expect(await inspectMerge(tenant, (tx, repo) => repo.messageCount(tx, customer.id))).toEqual(before);

    const thread = (await asUser(customer).get('/customer/conversation')).body as { items: { type: string; message?: { body: string } }[] };
    const texts = thread.items.filter((item) => item.type === 'message').map((item) => item.message?.body);
    expect(texts.filter((body) => body === 'merge-src-1')).toHaveLength(1);
    expect(texts.filter((body) => body === 'merge-tgt-1')).toHaveLength(1);

    const history = await inspect(tenant, (tx, repo) => repo.history(tx, source.id));
    expect(history.map((entry) => entry.field)).toEqual(expect.arrayContaining(['merged_into_id', 'state']));
  });

  it('is idempotent when the same merge is repeated', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open' });
    const target = await createTicket(tenant, { customer, state: 'open' });
    expect((await asUser(admin).post(`/tickets/${source.id}/merge`, { targetTicketId: target.id })).status).toBe(200);
    const again = await asUser(admin).post(`/tickets/${source.id}/merge`, { targetTicketId: target.id });
    expect(again.status).toBe(200);
    expect(await inspectMerge(tenant, (tx, repo) => repo.links(tx, source.id))).toHaveLength(1);
  });

  it('repoints tickets already merged into the source, so no chain forms', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const first = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'chain-first' }] });
    const middle = await createTicket(tenant, { customer, state: 'open' });
    const last = await createTicket(tenant, { customer, state: 'open' });
    expect((await asUser(admin).post(`/tickets/${first.id}/merge`, { targetTicketId: middle.id })).status).toBe(200);
    expect((await asUser(admin).post(`/tickets/${middle.id}/merge`, { targetTicketId: last.id })).status).toBe(200);
    expect((await inspectMerge(tenant, (tx, repo) => repo.ticket(tx, first.id))).merged_into_id).toBe(last.id);
    expect(bodies(await asUser(admin).get(`/tickets/${last.id}/messages`))).toContain('chain-first');
  });

  it('is 409 DIFFERENT_CUSTOMER, SAME_TICKET and ALREADY_MERGED', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const stranger = await createUser(tenant, { roles: ['customer'] });
    const a = await createTicket(tenant, { customer, state: 'open' });
    const b = await createTicket(tenant, { customer, state: 'open' });
    const c = await createTicket(tenant, { customer, state: 'open' });
    const foreign = await createTicket(tenant, { customer: stranger, state: 'open' });

    const different = await asUser(admin).post(`/tickets/${a.id}/merge`, { targetTicketId: foreign.id });
    expect([different.status, failure(different).error.code]).toEqual([409, 'DIFFERENT_CUSTOMER']);
    const same = await asUser(admin).post(`/tickets/${a.id}/merge`, { targetTicketId: a.id });
    expect([same.status, failure(same).error.code]).toEqual([409, 'SAME_TICKET']);

    expect((await asUser(admin).post(`/tickets/${a.id}/merge`, { targetTicketId: b.id })).status).toBe(200);
    const sourceMerged = await asUser(admin).post(`/tickets/${a.id}/merge`, { targetTicketId: c.id });
    expect([sourceMerged.status, failure(sourceMerged).error.code]).toEqual([409, 'ALREADY_MERGED']);
    const targetMerged = await asUser(admin).post(`/tickets/${c.id}/merge`, { targetTicketId: a.id });
    expect([targetMerged.status, failure(targetMerged).error.code]).toEqual([409, 'ALREADY_MERGED']);
  });

  it('is 403 without ticket.merge or edit on either group, and 404 when the target is not visible', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const editable = await createGroup(tenant);
    const viewOnly = await createGroup(tenant);
    const hidden = await createGroup(tenant);
    const agent = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'ticket.merge'], [
      { group: editable.id, flags: { view: true, edit: true } },
      { group: viewOnly.id, flags: { view: true } },
    ]);
    const inEditable = await createTicket(tenant, { customer, group: editable.id, state: 'open' });
    const inEditable2 = await createTicket(tenant, { customer, group: editable.id, state: 'open' });
    const inViewOnly = await createTicket(tenant, { customer, group: viewOnly.id, state: 'open' });
    const inHidden = await createTicket(tenant, { customer, group: hidden.id, state: 'open' });

    const toViewOnly = await asUser(agent).post(`/tickets/${inEditable.id}/merge`, { targetTicketId: inViewOnly.id });
    expect([toViewOnly.status, failure(toViewOnly).error.code]).toEqual([403, 'PERMISSION_DENIED']);
    const fromViewOnly = await asUser(agent).post(`/tickets/${inViewOnly.id}/merge`, { targetTicketId: inEditable.id });
    expect(fromViewOnly.status).toBe(403);
    const toHidden = await asUser(agent).post(`/tickets/${inEditable.id}/merge`, { targetTicketId: inHidden.id });
    expect(toHidden.status).toBe(404);

    const withoutKey = await staffWithRole(tenant, ['ticket.view', 'ticket.edit'], [{ group: editable.id, flags: { view: true, edit: true } }]);
    const denied = await asUser(withoutKey).post(`/tickets/${inEditable.id}/merge`, { targetTicketId: inEditable2.id });
    expect([denied.status, failure(denied).error.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await asUser(agent).post(`/tickets/${inEditable.id}/merge`, { targetTicketId: inEditable2.id })).status).toBe(200);
  });

  it("is 404 for another tenant's ticket as source or target, equal to an unknown id", async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const own = await createTicket(tenant, { customer, state: 'open' });
    const other = await createTenant();
    const otherCustomer = await createUser(other, { roles: ['customer'] });
    const foreign = await createTicket(other, { customer: otherCustomer, state: 'open' });

    await expectCrossTenant404((id) => asUser(admin).post(`/tickets/${id}/merge`, { targetTicketId: own.id }), foreign.id, 'TICKET_NOT_FOUND');
    await expectCrossTenant404((id) => asUser(admin).post(`/tickets/${own.id}/merge`, { targetTicketId: id }), foreign.id, 'TICKET_NOT_FOUND');
  });

  it('validates the request body', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    for (const body of [{}, { targetTicketId: 'nope' }, { targetTicketId: ticket.id, extra: 1 }]) {
      const response = await asUser(admin).post(`/tickets/${ticket.id}/merge`, body);
      expect([response.status, failure(response).error.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });
});

describe('POST /tickets/{id}/split', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  beforeAll(async () => {
    tenant = await createTenant();
    admin = await createUser(tenant, { roles: ['admin'] });
  });

  it('moves the message to a new split ticket linked split_from, and the next customer message lands on it (success)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', title: 'Original', messages: [{ body: 'first question' }, { body: 'A different problem\nmore detail' }] });
    const moving = await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'A different problem\nmore detail'));

    const response = await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: moving.id });
    expect(response.status).toBe(201);
    const created = response.body as TicketBody & { title: string };
    expect(created.id).not.toBe(source.id);
    expect(created.title).toBe('A different problem');
    expect(created.state).toBe('new');

    expect(await inspectMerge(tenant, (tx, repo) => repo.ticket(tx, created.id))).toMatchObject({ origin: 'split', customer_id: customer.id });
    expect(await inspectMerge(tenant, (tx, repo) => repo.links(tx, created.id))).toEqual([{ from_ticket_id: created.id, to_ticket_id: source.id, kind: 'split_from' }]);
    expect(bodies(await asUser(admin).get(`/tickets/${source.id}/messages`))).toEqual(['first question']);
    expect(bodies(await asUser(admin).get(`/tickets/${created.id}/messages`))).toEqual(['A different problem\nmore detail']);

    const next = await asUser(customer).post('/customer/messages', { body: 'follow-up after split', clientMessageId: uuidv7() });
    expect(next.status).toBeLessThan(300);
    expect((await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'follow-up after split'))).ticket_id).toBe(created.id);
  });

  it('uses the given title, and a repeat returns the ticket created the first time', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'keep' }, { body: 'split-repeat' }] });
    const moving = await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'split-repeat'));
    const first = await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: moving.id, title: 'Custom title' });
    expect([first.status, (first.body as { title: string }).title]).toEqual([201, 'Custom title']);
    const again = await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: moving.id });
    expect((again.body as TicketBody).id).toBe((first.body as TicketBody).id);
  });

  it('refuses internal notes with 409 MESSAGE_NOT_SPLITTABLE and messages of other tickets with 404', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'split-note', staff: admin, visibility: 'internal' }] });
    const note = await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'split-note'));
    const refused = await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: note.id });
    expect([refused.status, failure(refused).error.code]).toEqual([409, 'MESSAGE_NOT_SPLITTABLE']);

    await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'split-elsewhere' }] });
    const elsewhere = await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'split-elsewhere'));
    expect((await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: elsewhere.id })).status).toBe(404);
    expect((await asUser(admin).post(`/tickets/${source.id}/split`, { messageId: uuidv7() })).status).toBe(404);
  });

  it('is 403 without ticket.split or edit on the group, and 404 cross-tenant', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const source = await createTicket(tenant, { customer, group: group.id, state: 'open', messages: [{ body: 'split-perm' }] });
    const message = await inspectMerge(tenant, (tx, repo) => repo.messageTicket(tx, 'split-perm'));
    const viewer = await staffWithRole(tenant, ['ticket.view', 'ticket.split'], [{ group: group.id, flags: { view: true } }]);
    const withoutKey = await staffWithRole(tenant, ['ticket.view', 'ticket.edit'], [{ group: group.id, flags: { view: true, edit: true } }]);
    expect((await asUser(viewer).post(`/tickets/${source.id}/split`, { messageId: message.id })).status).toBe(403);
    expect((await asUser(withoutKey).post(`/tickets/${source.id}/split`, { messageId: message.id })).status).toBe(403);

    const other = await createTenant();
    const otherAdmin = await createUser(other, { roles: ['admin'] });
    const cross = await asUser(otherAdmin).post(`/tickets/${source.id}/split`, { messageId: message.id });
    const unknown = await asUser(otherAdmin).post(`/tickets/${UNKNOWN_ID}/split`, { messageId: message.id });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });
});

interface BulkResponse {
  results: { ticketId: string; ok: boolean; errorCode?: string }[];
}

class BulkInspect extends TenantRepository {
  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['state', 'priority', 'owner_id']).where('id', '=', ticketId).executeTakeFirstOrThrow();
  }

  tagIds(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_tags').select('tag_id').where('ticket_id', '=', ticketId).execute();
  }

  insertTag(tx: TenantTransaction, name: string) {
    return this.insertInto(tx, 'tags', { id: uuidv7(), name }).returning('id').executeTakeFirstOrThrow();
  }

  tagTicket(tx: TenantTransaction, ticketId: string, tagId: string) {
    return this.insertInto(tx, 'ticket_tags', { ticket_id: ticketId, tag_id: tagId }).execute();
  }
}

async function inspectBulk<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: BulkInspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'bulk-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new BulkInspect(ctx)));
}

describe('POST /tickets/bulk', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  beforeAll(async () => {
    tenant = await createTenant();
    admin = await createUser(tenant, { roles: ['admin'] });
  });

  it('applies the changes to every ticket with history, and adds tags without replacing them (success)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const a = await createTicket(tenant, { customer, state: 'open' });
    const b = await createTicket(tenant, { customer, state: 'new' });
    const kept = await inspectBulk(tenant, (tx, repo) => repo.insertTag(tx, `kept-${uuidv7().slice(-8)}`));
    const added = await inspectBulk(tenant, (tx, repo) => repo.insertTag(tx, `added-${uuidv7().slice(-8)}`));
    await inspectBulk(tenant, (tx, repo) => repo.tagTicket(tx, a.id, kept.id));

    const response = await asUser(admin).post('/tickets/bulk', {
      ticketIds: [a.id, b.id],
      changes: { priority: 'urgent', ownerId: admin.id, addTagIds: [added.id] },
    });
    expect(response.status).toBe(200);
    expect((response.body as BulkResponse).results).toEqual([
      { ticketId: a.id, ok: true },
      { ticketId: b.id, ok: true },
    ]);
    for (const id of [a.id, b.id]) {
      expect(await inspectBulk(tenant, (tx, repo) => repo.ticket(tx, id))).toMatchObject({ priority: 'urgent', owner_id: admin.id });
      const history = await inspect(tenant, (tx, repo) => repo.history(tx, id));
      expect(history.map((entry) => entry.field)).toEqual(expect.arrayContaining(['priority', 'owner_id']));
    }
    const tagsOfA = (await inspectBulk(tenant, (tx, repo) => repo.tagIds(tx, a.id))).map((row) => row.tag_id);
    expect(new Set(tagsOfA)).toEqual(new Set([kept.id, added.id]));
  });

  it('checks each ticket on its own: refusals do not block the others', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const editable = await createGroup(tenant);
    const viewOnly = await createGroup(tenant);
    const hidden = await createGroup(tenant);
    const agent = await staffWithRole(tenant, ['ticket.view', 'ticket.edit', 'ticket.bulk_update'], [
      { group: editable.id, flags: { view: true, edit: true } },
      { group: viewOnly.id, flags: { view: true } },
    ]);
    const ok = await createTicket(tenant, { customer, group: editable.id, state: 'open' });
    const closed = await createTicket(tenant, { customer, group: editable.id, state: 'closed' });
    const readOnly = await createTicket(tenant, { customer, group: viewOnly.id, state: 'open' });
    const invisible = await createTicket(tenant, { customer, group: hidden.id, state: 'open' });
    const other = await createTenant();
    const foreign = await createTicket(other, { customer: await createUser(other, { roles: ['customer'] }), state: 'open' });

    const response = await asUser(agent).post('/tickets/bulk', {
      ticketIds: [ok.id, closed.id, readOnly.id, invisible.id, foreign.id, UNKNOWN_ID, ok.id],
      changes: { state: 'resolved' },
    });
    expect(response.status).toBe(200);
    expect((response.body as BulkResponse).results).toEqual([
      { ticketId: ok.id, ok: true },
      { ticketId: closed.id, ok: false, errorCode: 'INVALID_TRANSITION' },
      { ticketId: readOnly.id, ok: false, errorCode: 'PERMISSION_DENIED' },
      { ticketId: invisible.id, ok: false, errorCode: 'TICKET_NOT_FOUND' },
      { ticketId: foreign.id, ok: false, errorCode: 'TICKET_NOT_FOUND' },
      { ticketId: UNKNOWN_ID, ok: false, errorCode: 'TICKET_NOT_FOUND' },
    ]);
    expect((await inspectBulk(tenant, (tx, repo) => repo.ticket(tx, ok.id))).state).toBe('resolved');
    expect((await inspectBulk(tenant, (tx, repo) => repo.ticket(tx, readOnly.id))).state).toBe('open');
    expect((await inspectBulk(other, (tx, repo) => repo.ticket(tx, foreign.id))).state).toBe('open');
  });

  it('reports OWNER_NOT_ELIGIBLE per ticket', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const outsider = await staffWithRole(tenant, ['ticket.view', 'ticket.edit'], []);
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const response = await asUser(admin).post('/tickets/bulk', { ticketIds: [ticket.id], changes: { ownerId: outsider.id } });
    expect((response.body as BulkResponse).results).toEqual([{ ticketId: ticket.id, ok: false, errorCode: 'OWNER_NOT_ELIGIBLE' }]);
  });

  it('is 403 PERMISSION_DENIED without ticket.bulk_update', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const agent = await staffWithRole(tenant, ['ticket.view', 'ticket.edit'], [{ group: null, flags: { view: true, edit: true } }]);
    const response = await asUser(agent).post('/tickets/bulk', { ticketIds: [ticket.id], changes: { priority: 'high' } });
    expect([response.status, failure(response).error.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('validates the request body', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => uuidv7());
    for (const body of [
      { ticketIds: [], changes: { priority: 'high' } },
      { ticketIds: ids(101), changes: { priority: 'high' } },
      { ticketIds: ids(1), changes: {} },
      { ticketIds: ids(1), changes: { title: 'nope' } },
      { ticketIds: ['nope'], changes: { priority: 'high' } },
      { ticketIds: ids(1) },
    ]) {
      const response = await asUser(admin).post('/tickets/bulk', body);
      expect([response.status, failure(response).error.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });
});
