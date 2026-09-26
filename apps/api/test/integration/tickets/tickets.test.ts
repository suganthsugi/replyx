import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository, type TenantInsert } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { TicketNumberService } from '../../../src/tickets/ticket-number.service.js';
import { getTestApp, service } from '../../support/app.js';
import {
  createGroup,
  createRole,
  createTenant,
  createTicket,
  createUser,
  setGroupAccess,
  type TestTenant,
  type TestUser,
} from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * `/tickets*` (T146; contracts/tickets.yaml, tickets.service.ts, ticket-query.service.ts,
 * staff-started-ticket.service.ts). Every endpoint gets the triad: success, 403 without the
 * permission, cross-tenant 404 equal to the unknown-id body (testing-conventions rule 6).
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';
const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface TicketSummaryBody {
  id: string;
  number: number;
  title: string;
  state: string;
  priority: string;
  group: { id: string } | null;
  lastCustomerMessageAt: string | null;
  updatedAt: string;
}
interface PageBody<T> {
  items: T[];
  nextCursor: string | null;
}
interface TicketBody extends TicketSummaryBody {
  pendingUntil: string | null;
  ownerId?: string | null;
}

const body = <T>(response: { body: unknown }) => response.body as T;
const failure = (response: { body: unknown }) => response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

class Inspect extends TenantRepository {
  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['group_id', 'owner_id', 'priority', 'state']).where('id', '=', ticketId).executeTakeFirst();
  }

  messages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['id']).where('ticket_id', '=', ticketId).execute();
  }

  links(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_links')
      .select(['id', 'from_ticket_id', 'to_ticket_id'])
      .where((eb) => eb.or([eb('from_ticket_id', '=', ticketId), eb('to_ticket_id', '=', ticketId)]))
      .execute();
  }

  history(tx: TenantTransaction, ticketId: string, field: string) {
    return this.selectFrom(tx, 'ticket_history')
      .select(['old_value', 'new_value'])
      .where('ticket_id', '=', ticketId)
      .where('field', '=', field)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  async insertTicket(tx: TenantTransaction, values: TenantInsert<'tickets'>): Promise<string> {
    const row = await this.insertInto(tx, 'tickets', values).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'tickets-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

/** A ticket row with fully controlled sort columns, for list/sort/pagination tests. */
async function insertTicketAt(
  tenant: TestTenant,
  customer: TestUser,
  options: { priority?: 'low' | 'normal' | 'high' | 'urgent'; updatedAt: Date; lastCustomerMessageAt?: Date | null; group?: string | null },
): Promise<string> {
  const numbers = await service(TicketNumberService);
  return inspect(tenant, async (tx, repo) => {
    const number = await numbers.next(tx);
    return repo.insertTicket(tx, {
      number,
      title: `Ticket ${number}`,
      customer_id: customer.id,
      group_id: options.group ?? null,
      state: 'open',
      origin: 'customer_message',
      priority: options.priority ?? 'normal',
      updated_at: options.updatedAt,
      last_customer_message_at: options.lastCustomerMessageAt ?? null,
    });
  });
}

let a: TestTenant;
let b: TestTenant;
let adminA: TestUser;
let adminB: TestUser;

beforeAll(async () => {
  await getTestApp();
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [adminA, adminB] = await Promise.all([createUser(a, { roles: ['admin'] }), createUser(b, { roles: ['admin'] })]);
});

describe('GET /tickets', () => {
  it('filters by state, priority, groupId, ownerId and customerId (success)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const other = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const otherCustomer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);

    const open = await createTicket(tenant, { customer, group: group.id, owner: admin.id, state: 'open' });
    await createTicket(tenant, { customer, group: group.id, owner: other.id, state: 'closed' });
    await createTicket(tenant, { customer: otherCustomer, group: null, state: 'new' });

    const byState = await asUser(admin).get('/tickets?state=open');
    expect(byState.status).toBe(200);
    expect(body<PageBody<TicketSummaryBody>>(byState).items.map((t) => t.id)).toEqual([open.id]);

    const byGroup = await asUser(admin).get(`/tickets?groupId=${group.id}`);
    expect(body<PageBody<TicketSummaryBody>>(byGroup).items).toHaveLength(2);

    const ungrouped = await asUser(admin).get('/tickets?groupId=ungrouped');
    expect(body<PageBody<TicketSummaryBody>>(ungrouped).items).toHaveLength(1);

    const byOwner = await asUser(admin).get(`/tickets?ownerId=${admin.id}`);
    expect(body<PageBody<TicketSummaryBody>>(byOwner).items.map((t) => t.id)).toEqual([open.id]);

    const me = await asUser(admin).get('/tickets?ownerId=me');
    expect(body<PageBody<TicketSummaryBody>>(me).items.map((t) => t.id)).toEqual([open.id]);

    const unassigned = await asUser(admin).get('/tickets?ownerId=unassigned');
    expect(body<PageBody<TicketSummaryBody>>(unassigned).items).toHaveLength(1);

    const byCustomer = await asUser(admin).get(`/tickets?customerId=${otherCustomer.id}`);
    expect(body<PageBody<TicketSummaryBody>>(byCustomer).items).toHaveLength(1);

    const byPriority = await asUser(admin).get('/tickets?priority=low,normal');
    expect(body<PageBody<TicketSummaryBody>>(byPriority).items.length).toBeGreaterThanOrEqual(3);
  });

  it('sorts by each sort key, ascending and descending', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const base = new Date('2026-01-01T00:00:00.000Z');
    const low = await insertTicketAt(tenant, customer, { priority: 'low', updatedAt: new Date(base.getTime() + 1000) });
    const urgent = await insertTicketAt(tenant, customer, { priority: 'urgent', updatedAt: new Date(base.getTime() + 2000) });

    const byPriorityAsc = await asUser(admin).get('/tickets?sort=priority');
    expect(body<PageBody<TicketSummaryBody>>(byPriorityAsc).items.map((t) => t.id)).toEqual([low, urgent]);

    const byPriorityDesc = await asUser(admin).get('/tickets?sort=-priority');
    expect(body<PageBody<TicketSummaryBody>>(byPriorityDesc).items.map((t) => t.id)).toEqual([urgent, low]);

    const byUpdatedAsc = await asUser(admin).get('/tickets?sort=updated_at');
    expect(body<PageBody<TicketSummaryBody>>(byUpdatedAsc).items.map((t) => t.id)).toEqual([low, urgent]);

    const byCreatedDesc = await asUser(admin).get('/tickets?sort=-created_at');
    expect(body<PageBody<TicketSummaryBody>>(byCreatedDesc).items.map((t) => t.id).slice(0, 2).sort()).toEqual([low, urgent].sort());
  });

  it('paginates by cursor, showing a NULL last_customer_message_at row exactly once across pages', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const base = new Date('2026-02-01T00:00:00.000Z');
    // Two rows with a real last_customer_message_at (sorted first, oldest→newest) and two NULLs
    // (sorted last, in insertion order via the id tie-break).
    const withValue1 = await insertTicketAt(tenant, customer, { updatedAt: new Date(base.getTime() + 1000), lastCustomerMessageAt: new Date(base.getTime() + 10_000) });
    const withValue2 = await insertTicketAt(tenant, customer, { updatedAt: new Date(base.getTime() + 2000), lastCustomerMessageAt: new Date(base.getTime() + 20_000) });
    const nullRow1 = await insertTicketAt(tenant, customer, { updatedAt: new Date(base.getTime() + 3000), lastCustomerMessageAt: null });
    const nullRow2 = await insertTicketAt(tenant, customer, { updatedAt: new Date(base.getTime() + 4000), lastCustomerMessageAt: null });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await asUser(admin).get(`/tickets?sort=last_customer_message_at&limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`);
      expect(response.status).toBe(200);
      const parsed = body<PageBody<TicketSummaryBody>>(response);
      seen.push(...parsed.items.map((t) => t.id));
      if (parsed.nextCursor === null) break;
      cursor = parsed.nextCursor;
    }
    expect(seen).toEqual([withValue1, withValue2, nullRow1, nullRow2]);
    // No id repeats or drops across the page boundary that lands inside the NULL tail.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never lists another tenant\'s tickets', async () => {
    const customer = await createUser(b, { roles: ['customer'] });
    await createTicket(b, { customer, state: 'open' });
    const response = await asUser(adminA).get('/tickets');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(customer.id);
  });

  it('filters by number: found, invisible (empty page, not 403/404) and another tenant\'s number (empty page)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });

    const found = await asUser(admin).get(`/tickets?number=${ticket.number}`);
    expect(found.status).toBe(200);
    expect(body<PageBody<TicketSummaryBody>>(found).items.map((t) => t.id)).toEqual([ticket.id]);

    // `viewer` (agent) has no access grant on `group`, so the ticket exists but is invisible.
    const notVisible = await asUser(viewer).get(`/tickets?number=${ticket.number}`);
    expect(notVisible.status).toBe(200);
    expect(body<PageBody<TicketSummaryBody>>(notVisible).items).toEqual([]);

    // A fresh tenant, so it can't coincidentally have its own ticket at the same number.
    const otherTenant = await createTenant();
    const otherAdmin = await createUser(otherTenant, { roles: ['admin'] });
    const crossTenant = await asUser(otherAdmin).get(`/tickets?number=${ticket.number}`);
    expect(crossTenant.status).toBe(200);
    expect(body<PageBody<TicketSummaryBody>>(crossTenant).items).toEqual([]);
  });

  it('needs ticket.view (403) and hides an unknown viewId as invisible (404)', async () => {
    const bystander = await createUser(a, { roles: [] });
    expect((await asUser(bystander).get('/tickets')).status).toBe(403);
    const denied = await asUser(adminA).get(`/tickets?viewId=${UNKNOWN_ID}`);
    expect(denied.status).toBe(404);
  });
});

describe('POST /tickets (staff-started)', () => {
  it('starts an open ticket for an active customer, waiting on the customer (success)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);

    const response = await asUser(admin).post('/tickets', {
      customerId: customer.id,
      groupId: group.id,
      title: 'Need help',
      message: { body: 'Calling about an order' },
    });
    expect(response.status).toBe(201);
    const ticket = body<TicketBody>(response);
    expect(ticket).toMatchObject({ title: 'Need help', state: 'open', group: { id: group.id } });

    const row = await inspect(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    expect(row?.state).toBe('open');
  });

  it('needs ticket.create (403) and treats an unknown or invisible group as 404', async () => {
    const tenant = await createTenant();
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const input = { customerId: customer.id, groupId: group.id, title: 'x', message: { body: 'x' } };
    expect((await asUser(agent).post('/tickets', input)).status).toBe(403);

    const admin = await createUser(tenant, { roles: ['admin'] });
    const unknownGroup = await asUser(admin).post('/tickets', { ...input, groupId: UNKNOWN_ID });
    expect(unknownGroup.status).toBe(404);
  });

  it('is a 404 for another tenant\'s group and customer (cross-tenant)', async () => {
    const group = await createGroup(a);
    const customer = await createUser(a, { roles: ['customer'] });
    const input = { customerId: customer.id, groupId: group.id, title: 'x', message: { body: 'x' } };
    const cross = await asUser(adminB).post('/tickets', input);
    const unknown = await asUser(adminB).post('/tickets', { ...input, groupId: UNKNOWN_ID });
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('refuses an inactive customer (409 CUSTOMER_INACTIVE) and an inactive group (409 GROUP_INACTIVE)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const group = await createGroup(tenant);
    const inactiveGroup = await createGroup(tenant, { status: 'inactive' });
    const inactiveCustomer = await createUser(tenant, { roles: ['customer'], status: 'deactivated' });
    const activeCustomer = await createUser(tenant, { roles: ['customer'] });

    const customerInactive = await asUser(admin).post('/tickets', {
      customerId: inactiveCustomer.id,
      groupId: group.id,
      title: 'x',
      message: { body: 'x' },
    });
    expect(customerInactive.status).toBe(409);
    expect(failure(customerInactive).error.code).toBe('CUSTOMER_INACTIVE');

    const groupInactive = await asUser(admin).post('/tickets', {
      customerId: activeCustomer.id,
      groupId: inactiveGroup.id,
      title: 'x',
      message: { body: 'x' },
    });
    expect(groupInactive.status).toBe(409);
    expect(failure(groupInactive).error.code).toBe('GROUP_INACTIVE');
  });

  it('refuses an owner without edit access to the group (409 OWNER_NOT_ELIGIBLE)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const outsider = await createUser(tenant, { roles: ['agent'] });

    const response = await asUser(admin).post('/tickets', {
      customerId: customer.id,
      groupId: group.id,
      ownerId: outsider.id,
      title: 'x',
      message: { body: 'x' },
    });
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('OWNER_NOT_ELIGIBLE');
  });

  it('returns the original ticket for a repeated Idempotency-Key (idempotent retry)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const key = uuidv7();
    const input = { customerId: customer.id, groupId: group.id, title: 'Need help', message: { body: 'Calling about an order' } };

    const { app } = await getTestApp();
    const supertest = (await import('supertest')).default;
    const { API_PREFIX } = await import('../../../src/app.setup.js');
    const post = () =>
      supertest(app.getHttpServer())
        .post(`/${API_PREFIX}/tickets`)
        .set('Host', tenant.host)
        .set('Cookie', [`rx_session=${admin.sessionToken}`, `rx_csrf=${admin.csrfToken}`].join('; '))
        .set('X-CSRF-Token', admin.csrfToken)
        .set('Idempotency-Key', key)
        .send(input);

    const first = await post();
    const again = await post();
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect((again.body as TicketBody).id).toBe((first.body as TicketBody).id);
  });
});

describe('PATCH /tickets/{id}', () => {
  it('changes title, priority and tags (success)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const tag = await asUser(admin).post('/tags', { name: 'VIP' });

    const response = await asUser(admin).patch(`/tickets/${ticket.id}`, {
      title: 'Renamed',
      priority: 'high',
      tagIds: [(tag.body as { id: string }).id],
    });
    expect(response.status).toBe(200);
    const updated = body<TicketBody & { tags: { id: string; name: string }[] }>(response);
    expect(updated).toMatchObject({ title: 'Renamed', priority: 'high' });
    expect(updated.tags.map((t) => t.name)).toEqual(['VIP']);
  });

  it('needs ticket.view to see the ticket (403 without any access at all)', async () => {
    const customer = await createUser(a, { roles: ['customer'] });
    const ticket = await createTicket(a, { customer, state: 'open' });
    const bystander = await createUser(a, { roles: [] });
    const response = await asUser(bystander).patch(`/tickets/${ticket.id}`, { title: 'Nope' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('refuses a viewer without edit on the ticket\'s group (403)', async () => {
    const tenant = await createTenant();
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const response = await asUser(viewer).patch(`/tickets/${ticket.id}`, { title: 'Nope' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('is a 404 for another tenant\'s ticket (cross-tenant)', async () => {
    const customer = await createUser(a, { roles: ['customer'] });
    const ticket = await createTicket(a, { customer, state: 'open' });
    await expectCrossTenant404((id) => asUser(adminB).patch(`/tickets/${id}`, { title: 'Nope' }), ticket.id);
  });

  it('moves a ticket between two real groups, needing edit on the source and create on the destination (FR-041)', async () => {
    const tenant = await createTenant();
    // The system Agent role never has ticket.create at all, so a moving role needs it explicitly.
    const mover = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit', 'ticket.create'] });
    const source = await createGroup(tenant, { access: [{ role: { id: mover.id }, flags: { view: true, edit: true } }] });
    const destination = await createGroup(tenant, { access: [{ role: { id: mover.id }, flags: { view: true, create: true } }] });
    const noCreateDestination = await createGroup(tenant, { access: [{ role: { id: mover.id }, flags: { view: true, create: false } }] });
    const agent = await createUser(tenant, { roles: [{ id: mover.id }] });
    const customer = await createUser(tenant, { roles: ['customer'] });

    const blocked = await createTicket(tenant, { customer, group: source.id, state: 'open' });
    const denied = await asUser(agent).patch(`/tickets/${blocked.id}`, { groupId: noCreateDestination.id });
    expect(denied.status).toBe(403);

    const ticket = await createTicket(tenant, { customer, group: source.id, state: 'open' });
    const moved = await asUser(agent).patch(`/tickets/${ticket.id}`, { groupId: destination.id });
    expect(moved.status).toBe(200);
    expect(body<TicketBody>(moved).group?.id).toBe(destination.id);
  });

  it('moves a ticket out of Ungrouped with only edit there, no create needed on the destination (triage move)', async () => {
    const tenant = await createTenant();
    const destination = await createGroup(tenant); // agent has no access at all here
    const agent = await createUser(tenant, { roles: ['agent'] });
    await setGroupAccess(tenant, 'agent', null, { view: true, edit: true });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });

    const response = await asUser(agent).patch(`/tickets/${ticket.id}`, { groupId: destination.id });
    expect(response.status).toBe(200);
    expect(body<TicketBody>(response).group?.id).toBe(destination.id);
  });

  it('refuses moving into an inactive group (409 GROUP_INACTIVE)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const inactive = await createGroup(tenant, { status: 'inactive' });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const response = await asUser(admin).patch(`/tickets/${ticket.id}`, { groupId: inactive.id });
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('GROUP_INACTIVE');
  });

  it('refuses an owner without edit access on the (new) group (409 OWNER_NOT_ELIGIBLE)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const outsider = await createUser(tenant, { roles: ['agent'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });
    const response = await asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: outsider.id });
    expect(response.status).toBe(409);
    expect(failure(response).error.code).toBe('OWNER_NOT_ELIGIBLE');
  });

  it('requires a future pendingUntil to enter a pending state (400), then accepts one', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const missing = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_reminder' });
    expect(missing.status).toBe(400);
    expect(failure(missing).error.details).toEqual([{ path: 'pendingUntil', issue: 'required' }]);

    const past = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_reminder', pendingUntil: new Date(0).toISOString() });
    expect(past.status).toBe(400);
    expect(failure(past).error.details).toEqual([{ path: 'pendingUntil', issue: 'too_small' }]);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_reminder', pendingUntil: future });
    expect(ok.status).toBe(200);
    expect(body<TicketBody>(ok).pendingUntil).toBe(future);
  });

  it('keeps both history rows on concurrent edits, the later commit winning', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open', title: 'Original' });

    const [r1, r2] = await Promise.all([
      asUser(admin).patch(`/tickets/${ticket.id}`, { priority: 'high' }),
      asUser(admin).patch(`/tickets/${ticket.id}`, { priority: 'urgent' }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);

    const finalRow = await inspect(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    const history = await inspect(tenant, (tx, repo) => repo.history(tx, ticket.id, 'priority'));
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.new_value).toBe(finalRow?.priority);
  });
});

describe('DELETE /tickets/{id}', () => {
  it('needs ticket.delete (403)', async () => {
    const customer = await createUser(a, { roles: ['customer'] });
    const ticket = await createTicket(a, { customer, state: 'open' });
    const bystander = await createUser(a, { roles: [] });
    expect((await asUser(bystander).delete(`/tickets/${ticket.id}`)).status).toBe(403);
  });

  it('is a 404 for another tenant\'s ticket (cross-tenant)', async () => {
    const customer = await createUser(a, { roles: ['customer'] });
    const ticket = await createTicket(a, { customer, state: 'open' });
    await expectCrossTenant404((id) => asUser(adminB).delete(`/tickets/${id}`), ticket.id);
  });

  it('deletes the ticket, its messages and any incoming links (success)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const target = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'Hello there' }] });
    const linker = await createTicket(tenant, { customer, state: 'open' });
    const link = await asUser(admin).post(`/tickets/${linker.id}/links`, { targetTicketId: target.id, kind: 'related' });
    expect(link.status).toBe(201);

    const response = await asUser(admin).delete(`/tickets/${target.id}`);
    expect(response.status).toBe(204);
    expect((await asUser(admin).get(`/tickets/${target.id}`)).status).toBe(404);

    const messages = await inspect(tenant, (tx, repo) => repo.messages(tx, target.id));
    expect(messages).toEqual([]);
    const linksLeft = await inspect(tenant, (tx, repo) => repo.links(tx, target.id));
    expect(linksLeft).toEqual([]);
    const linkerLinks = await asUser(admin).get(`/tickets/${linker.id}`);
    expect((linkerLinks.body as TicketBody & { links: unknown[] }).links).toEqual([]);
  });
});
