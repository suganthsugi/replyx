import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

/**
 * Ticket links, history and message moves (ticket-links.{service,controller}.ts,
 * ticket-history-query.service.ts, message-move.service.ts; contracts/tickets.yaml
 * `/tickets/{id}/links*`, `/tickets/{id}/history`, `/tickets/{id}/messages/{messageId}/move`,
 * FR-042 area, T147).
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface TicketDtoView {
  id: string;
  links: { id: string; kind: string; direction: string; ticket: { id: string } | null; removedReason: string | null }[];
}

class Inspect extends TenantRepository {
  message(tx: TenantTransaction, ticketId: string, body: string) {
    return this.selectFrom(tx, 'ticket_messages')
      .select(['id', 'author_kind', 'ticket_id'])
      .where('ticket_id', '=', ticketId)
      .where('body', '=', body)
      .executeTakeFirstOrThrow();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history').select(['field', 'old_value', 'new_value']).where('ticket_id', '=', ticketId).orderBy('created_at').execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant();
});

describe('POST /tickets/{id}/links', () => {
  it('creates follow_up_of, related and duplicate_of links (success)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const from = await createTicket(tenant, { customer, state: 'open' });
    const [followUp, related, duplicate] = await Promise.all([
      createTicket(tenant, { customer, state: 'open' }),
      createTicket(tenant, { customer, state: 'open' }),
      createTicket(tenant, { customer, state: 'open' }),
    ]);

    for (const [target, kind] of [
      [followUp, 'follow_up_of'],
      [related, 'related'],
      [duplicate, 'duplicate_of'],
    ] as const) {
      const response = await asUser(admin).post(`/tickets/${from.id}/links`, { targetTicketId: target.id, kind });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        kind,
        direction: 'outgoing',
        ticket: { id: target.id, number: target.number },
        removedReason: null,
      });
    }
  });

  it('refuses a repeated link (409 LINK_ALREADY_EXISTS)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const from = await createTicket(tenant, { customer, state: 'open' });
    const to = await createTicket(tenant, { customer, state: 'open' });
    expect((await asUser(admin).post(`/tickets/${from.id}/links`, { targetTicketId: to.id, kind: 'related' })).status).toBe(201);

    const again = await asUser(admin).post(`/tickets/${from.id}/links`, { targetTicketId: to.id, kind: 'related' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual(errorBody('LINK_ALREADY_EXISTS'));
  });

  it('refuses a link to itself (409 SAME_TICKET)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(admin).post(`/tickets/${ticket.id}/links`, { targetTicketId: ticket.id, kind: 'related' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('SAME_TICKET'));
  });

  it('shows a link to a ticket the caller cannot see as ticket: null, removedReason: not_visible', async () => {
    const groupA = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: true } }] });
    const groupB = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const visible = await createTicket(tenant, { customer, group: groupA.id, state: 'open' });
    const hidden = await createTicket(tenant, { customer, group: groupB.id, state: 'open' });

    // Admin can see both groups, so the link itself is created successfully.
    expect((await asUser(admin).post(`/tickets/${visible.id}/links`, { targetTicketId: hidden.id, kind: 'related' })).status).toBe(201);

    const seen = await asUser(agent).get(`/tickets/${visible.id}`);
    expect(seen.status).toBe(200);
    const body = seen.body as TicketDtoView;
    expect(body.links).toEqual([{ id: expect.any(String) as string, kind: 'related', direction: 'outgoing', ticket: null, removedReason: 'not_visible' }]);
  });

  it('deletes a link', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const from = await createTicket(tenant, { customer, state: 'open' });
    const to = await createTicket(tenant, { customer, state: 'open' });
    const link = await asUser(admin).post(`/tickets/${from.id}/links`, { targetTicketId: to.id, kind: 'related' });
    const linkId = (link.body as { id: string }).id;

    const deleted = await asUser(admin).delete(`/tickets/${from.id}/links/${linkId}`);
    expect(deleted.status).toBe(204);

    const after = await asUser(admin).get(`/tickets/${from.id}`);
    expect((after.body as TicketDtoView).links).toEqual([]);
  });

  it('refuses a staff member with view but no edit access to the group (403)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const from = await createTicket(tenant, { customer, group: group.id, state: 'open' });
    const to = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(viewer).post(`/tickets/${from.id}/links`, { targetTicketId: to.id, kind: 'related' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it("hides another tenant's ticket, same as an unknown one (404)", async () => {
    const other = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const from = await createTicket(tenant, { customer, state: 'open' });
    const otherCustomer = await createUser(other, { roles: ['customer'] });
    const foreign = await createTicket(other, { customer: otherCustomer, state: 'open' });

    const response = await asUser(admin).post(`/tickets/${foreign.id}/links`, { targetTicketId: from.id, kind: 'related' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody('TICKET_NOT_FOUND'));
  });
});

describe('GET /tickets/{id}/history', () => {
  it('lists PATCH changes newest first, with cursor pagination', async () => {
    const { clock } = await getTestApp();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open', title: 'Original title' });

    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { title: 'First edit' })).status).toBe(200);
    clock.advance(1_000);
    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { priority: 'high' })).status).toBe(200);
    clock.advance(1_000);
    expect((await asUser(admin).patch(`/tickets/${ticket.id}`, { title: 'Second edit' })).status).toBe(200);

    const first = await asUser(admin).get(`/tickets/${ticket.id}/history?limit=2`);
    expect(first.status).toBe(200);
    const firstPage = first.body as { items: { field: string }[]; nextCursor: string | null };
    expect(firstPage.items.map((item) => item.field)).toEqual(['title', 'priority']);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await asUser(admin).get(`/tickets/${ticket.id}/history?limit=2&cursor=${firstPage.nextCursor ?? ''}`);
    const secondPage = second.body as { items: { field: string }[]; nextCursor: string | null };
    expect(secondPage.items.map((item) => item.field)).toEqual(['title']);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('lists owner, priority and state changes sent as separate PATCH requests, the desk UI shape (US6/T157)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    // Matches apps/web/src/pages/desk/inbox/TicketFocus.tsx: "Assign to me", the priority group and
    // the state selector each fire their own PATCH, not one combined request, and often overlap.
    const [ownerPatch, priorityPatch, statePatch] = await Promise.all([
      asUser(admin).patch(`/tickets/${ticket.id}`, { ownerId: admin.id }),
      asUser(admin).patch(`/tickets/${ticket.id}`, { priority: 'high' }),
      asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'resolved', pendingUntil: null }),
    ]);
    expect(ownerPatch.status).toBe(200);
    expect(priorityPatch.status).toBe(200);
    expect(statePatch.status).toBe(200);

    const history = await asUser(admin).get(`/tickets/${ticket.id}/history?limit=50`);
    expect(history.status).toBe(200);
    const page = history.body as { items: { field: string }[]; nextCursor: string | null };
    expect(page.items.map((item) => item.field)).toEqual(expect.arrayContaining(['owner_id', 'priority', 'state']));
    expect(page.nextCursor).toBeNull();
  });

  it('refuses a staff member without ticket.view (403)', async () => {
    const bystander = await createUser(tenant, { roles: [] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, state: 'open' });

    const response = await asUser(bystander).get(`/tickets/${ticket.id}/history`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it("hides another tenant's ticket, same as an unknown one (404)", async () => {
    const other = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const otherCustomer = await createUser(other, { roles: ['customer'] });
    const foreign = await createTicket(other, { customer: otherCustomer, state: 'open' });

    const response = await asUser(admin).get(`/tickets/${foreign.id}/history`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody('TICKET_NOT_FOUND'));
  });
});

describe('POST /tickets/{id}/messages/{messageId}/move', () => {
  it("moves a customer message across the same customer's tickets, recording moved_from_ticket_id and history on both (success)", async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'Wrong thread message' }] });
    const target = await createTicket(tenant, { customer, state: 'open' });
    const message = await inspect(tenant, (tx, repo) => repo.message(tx, source.id, 'Wrong thread message'));

    const [sourceSocket, targetSocket] = await Promise.all([connectSocket(admin), connectSocket(admin)]);
    try {
      expect(await sourceSocket.emitWithAck('subscribe', { stream: `ticket:${source.id}` })).toEqual({ ok: true });
      expect(await targetSocket.emitWithAck('subscribe', { stream: `ticket:${target.id}` })).toEqual({ ok: true });
      const onSource = waitForEvent<{ type: string; data: { id: string } }>(sourceSocket, 'event', (e) => e.type === 'message.moved');
      const onTarget = waitForEvent<{ type: string; data: { id: string } }>(targetSocket, 'event', (e) => e.type === 'message.moved');

      const response = await asUser(admin).post(`/tickets/${source.id}/messages/${message.id}/move`, { targetTicketId: target.id });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: message.id, ticketId: target.id, movedFromTicketId: source.id });

      expect((await onSource).data.id).toBe(message.id);
      expect((await onTarget).data.id).toBe(message.id);
    } finally {
      sourceSocket.close();
      targetSocket.close();
    }

    const sourceHistory = await inspect(tenant, (tx, repo) => repo.history(tx, source.id));
    const targetHistory = await inspect(tenant, (tx, repo) => repo.history(tx, target.id));
    expect(sourceHistory.some((row) => row.field === 'message_moved')).toBe(true);
    expect(targetHistory.some((row) => row.field === 'message_moved')).toBe(true);
  });

  it('refuses moving to a ticket belonging to a different customer (409 DIFFERENT_CUSTOMER)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customerA = await createUser(tenant, { roles: ['customer'] });
    const customerB = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer: customerA, state: 'open', messages: [{ body: 'For customer A' }] });
    const target = await createTicket(tenant, { customer: customerB, state: 'open' });
    const message = await inspect(tenant, (tx, repo) => repo.message(tx, source.id, 'For customer A'));

    const response = await asUser(admin).post(`/tickets/${source.id}/messages/${message.id}/move`, { targetTicketId: target.id });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('DIFFERENT_CUSTOMER'));
  });

  it('refuses moving a staff message (409 MESSAGE_NOT_MOVABLE)', async () => {
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'A staff reply', staff: admin }] });
    const target = await createTicket(tenant, { customer, state: 'open' });
    const message = await inspect(tenant, (tx, repo) => repo.message(tx, source.id, 'A staff reply'));

    const response = await asUser(admin).post(`/tickets/${source.id}/messages/${message.id}/move`, { targetTicketId: target.id });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(errorBody('MESSAGE_NOT_MOVABLE'));
  });

  it('refuses a staff member without ticket.move_message on the source group (403)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, group: group.id, state: 'open', messages: [{ body: 'Please move me' }] });
    const target = await createTicket(tenant, { customer, state: 'open' });
    const message = await inspect(tenant, (tx, repo) => repo.message(tx, source.id, 'Please move me'));

    const response = await asUser(viewer).post(`/tickets/${source.id}/messages/${message.id}/move`, { targetTicketId: target.id });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('refuses a staff member without ticket.move_message on the target group (403)', async () => {
    const restricted = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const open = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: true } }] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const source = await createTicket(tenant, { customer, group: open.id, state: 'open', messages: [{ body: 'Please move me too' }] });
    const target = await createTicket(tenant, { customer, group: restricted.id, state: 'open' });
    const message = await inspect(tenant, (tx, repo) => repo.message(tx, source.id, 'Please move me too'));

    const response = await asUser(agent).post(`/tickets/${source.id}/messages/${message.id}/move`, { targetTicketId: target.id });
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it("hides another tenant's ticket, same as an unknown one (404)", async () => {
    const other = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const target = await createTicket(tenant, { customer, state: 'open' });
    const otherCustomer = await createUser(other, { roles: ['customer'] });
    const foreign = await createTicket(other, { customer: otherCustomer, state: 'open', messages: [{ body: 'Elsewhere' }] });
    const message = await inspect(other, (tx, repo) => repo.message(tx, foreign.id, 'Elsewhere'));

    const response = await asUser(admin).post(`/tickets/${foreign.id}/messages/${message.id}/move`, { targetTicketId: target.id });
    expect(response.status).toBe(404);
    expect(response.body).toEqual(errorBody('TICKET_NOT_FOUND'));
  });
});
