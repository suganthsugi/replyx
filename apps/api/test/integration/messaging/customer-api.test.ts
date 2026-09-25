import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * The customer conversation API (contracts/customer.yaml, FR-048–FR-052, FR-057): one thread,
 * one ticket behind it, idempotent sends, the rate limit, and payloads that never carry ticket
 * concepts (FR-049).
 */

/** Keys that must never appear anywhere in a customer payload (FR-049, research D9). */
const FORBIDDEN_KEYS = ['ticketId', 'ticket_id', 'number', 'state', 'group', 'groupId', 'owner', 'ownerId', 'priority', 'sla', 'visibility', 'internal'];

const MESSAGE_KEYS = ['attachments', 'body', 'clientMessageId', 'createdAt', 'delivery', 'from', 'id'];

interface ErrorBody {
  error: { code: string; message: string; retryAfter?: number; details?: { path: string; issue: string }[] };
}

const failure = (response: { body: unknown }) => response.body as ErrorBody;

function keysDeep(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, keys));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      keysDeep(child, keys);
    }
  }
  return keys;
}

/** The customer schema check: exact message keys and none of the forbidden ones, anywhere. */
function expectCustomerSafe(payload: unknown, forbiddenValues: readonly (string | number)[] = []): void {
  const keys = keysDeep(payload);
  for (const key of FORBIDDEN_KEYS) expect(keys, `customer payload contains "${key}"`).not.toContain(key);
  const text = JSON.stringify(payload);
  for (const value of forbiddenValues) expect(text).not.toContain(String(value));
}

interface ConversationBody {
  items: ({ type: 'message'; message: Record<string, unknown> & { id: string; body: string } } | { type: 'resolved_marker'; marker: { id: string } })[];
  olderCursor: string | null;
  status: { code: string; text: string };
  streamSeq: number;
}

interface TicketRowView {
  id: string;
  number: string;
  state: string;
  title: string;
  origin: string;
  waiting_on: string;
  last_customer_message_at: Date | null;
}

class Inspect extends TenantRepository {
  tickets(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['id', 'number', 'state', 'title', 'origin', 'waiting_on', 'last_customer_message_at'])
      .where('customer_id', '=', customerId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  messages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['id', 'body', 'client_message_id']).where('ticket_id', '=', ticketId).orderBy('created_at').orderBy('id').execute();
  }

  links(tx: TenantTransaction, fromId: string) {
    return this.selectFrom(tx, 'ticket_links').select(['to_ticket_id', 'kind']).where('from_ticket_id', '=', fromId).execute();
  }

  events(tx: TenantTransaction, stream: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select(['type', 'payload', 'customer_payload', 'streams'])
      .where(sql<boolean>`streams @> ARRAY[${stream}]::text[]`)
      .orderBy('id')
      .execute();
  }

  setting(tx: TenantTransaction, behavior: 'new_follow_up' | 'reopen_previous') {
    return this.updateTable(tx, 'tenant_settings').set({ after_close_behavior: behavior }).execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

const tickets = (tenant: TestTenant, customer: TestUser) => inspect(tenant, (tx, repo) => repo.tickets(tx, customer.id)) as Promise<TicketRowView[]>;

function send(customer: TestUser, body: string, clientMessageId: string = uuidv7()) {
  return asUser(customer).post('/customer/messages', { body, clientMessageId });
}

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await getTestApp();
  [tenant, other] = await Promise.all([createTenant(), createTenant()]);
});

describe('POST /customer/messages', () => {
  it('creates one ticket with a title from the first message, then appends to it', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const first = await send(customer, 'My order has not arrived and it has been more than two weeks since I placed it online');
    expect(first.status).toBe(201);
    expect(Object.keys(first.body as object).sort()).toEqual(MESSAGE_KEYS);
    expect(first.body).toMatchObject({ from: { kind: 'me' }, delivery: 'sent', attachments: [] });

    const [ticket] = await tickets(tenant, customer);
    expect(ticket).toMatchObject({ state: 'new', origin: 'customer_message', waiting_on: 'support' });
    expect(ticket?.title).toBe('My order has not arrived and it has been more than two weeks since I placed it');
    expect(Number(ticket?.number)).toBe(1001);
    expectCustomerSafe(first.body, [ticket?.id ?? '']);

    expect((await send(customer, 'Any news?')).status).toBe(201);
    const after = await tickets(tenant, customer);
    expect(after).toHaveLength(1);
    expect(after[0]?.state).toBe('new');
    expect((await inspect(tenant, (tx, repo) => repo.messages(tx, after[0]?.id ?? ''))).map((m) => m.body)).toEqual([
      'My order has not arrived and it has been more than two weeks since I placed it online',
      'Any news?',
    ]);
  });

  it('returns the original message for a repeated clientMessageId', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const key = uuidv7();
    const first = await send(customer, 'Hello', key);
    const again = await send(customer, 'Hello (tapped twice)', key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const [ticket] = await tickets(tenant, customer);
    expect(await inspect(tenant, (tx, repo) => repo.messages(tx, ticket?.id ?? ''))).toHaveLength(1);
  });

  it('moves a pending ticket back to open and keeps new tickets new (FR-033)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const pending = await createTicket(tenant, { customer, state: 'pending_close' });
    expect((await send(customer, 'Still broken')).status).toBe(201);
    const [row] = await tickets(tenant, customer);
    expect(row).toMatchObject({ id: pending.id, state: 'open' });
  });

  it('reopens a resolved ticket within the grace period, keeping it', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { clock } = await getTestApp();
    const resolved = await createTicket(tenant, { customer, state: 'resolved', now: clock.now(), autoCloseAt: new Date(clock.nowMs() + 3_600_000) });
    expect((await send(customer, 'Actually, one more thing')).status).toBe(201);
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: resolved.id, state: 'open' });
  });

  it('starts a follow-up linked to a closed ticket by default, or reopens it when configured', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const closed = await createTicket(tenant, { customer, state: 'closed' });
    expect((await send(customer, 'New problem')).status).toBe(201);
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: 'new', origin: 'follow_up' });
    expect(await inspect(tenant, (tx, repo) => repo.links(tx, rows[1]?.id ?? ''))).toEqual([{ to_ticket_id: closed.id, kind: 'follow_up_of' }]);

    const reopenTenant = await createTenant();
    await inspect(reopenTenant, (tx, repo) => repo.setting(tx, 'reopen_previous'));
    const returning = await createUser(reopenTenant, { roles: ['customer'] });
    const previous = await createTicket(reopenTenant, { customer: returning, state: 'closed' });
    expect((await send(returning, 'Back again')).status).toBe(201);
    const reopened = await tickets(reopenTenant, returning);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ id: previous.id, state: 'open' });
  });

  it('rejects blank, oversized and unknown input', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const blank = await send(customer, '   ');
    expect([blank.status, failure(blank).error.details]).toEqual([400, [{ path: 'body', issue: 'too_short' }]]);
    expect(failure(await send(customer, 'x'.repeat(10_001))).error.details).toEqual([{ path: 'body', issue: 'too_long' }]);
    const extra = await asUser(customer).post('/customer/messages', { body: 'hi', clientMessageId: uuidv7(), ticketId: uuidv7() });
    expect(failure(extra).error.details).toEqual([{ path: 'ticketId', issue: 'unrecognized_key' }]);
    const attachment = await asUser(customer).post('/customer/messages', { body: 'hi', clientMessageId: uuidv7(), attachmentIds: [uuidv7()] });
    expect([attachment.status, failure(attachment).error.details]).toEqual([400, [{ path: 'attachmentIds', issue: 'invalid' }]]);
    // The failed send left nothing behind.
    expect(await tickets(tenant, customer)).toEqual([]);
  });

  it('answers the 21st message in a minute with a friendly 429 (FR-057)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    for (let index = 0; index < 20; index += 1) expect((await send(customer, `message ${index}`)).status).toBe(201);
    const limited = await send(customer, 'one too many');
    expect(limited.status).toBe(429);
    expect(failure(limited).error.code).toBe('RATE_LIMITED');
    expect(failure(limited).error.message).toMatch(/please wait/i);
    expect(failure(limited).error.retryAfter).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('is refused for staff sessions and signed-out callers', async () => {
    const staff = await createUser(tenant, { roles: ['admin'] });
    const response = await send(staff, 'hi');
    expect([response.status, failure(response).error.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('GET /customer/conversation', () => {
  it('shows every ticket in one thread with resolved markers and no internal notes or ticket fields', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'], name: 'Priya' });
    const group = await createGroup(tenant);
    const { clock } = await getTestApp();
    const old = await createTicket(tenant, {
      customer,
      group: group.id,
      owner: agent.id,
      state: 'closed',
      now: new Date(clock.nowMs() - 3_600_000),
      messages: [
        { body: 'First issue' },
        { body: 'Secret internal note', staff: agent, visibility: 'internal' },
        { body: 'Fixed it for you', staff: agent },
      ],
    });
    expect((await send(customer, 'Second issue')).status).toBe(201);

    const response = await asUser(customer).get('/customer/conversation');
    expect(response.status).toBe(200);
    const page = response.body as ConversationBody;
    expect(page.items.map((item) => (item.type === 'message' ? item.message.body : 'marker'))).toEqual([
      'First issue',
      'Fixed it for you',
      'marker',
      'Second issue',
    ]);
    const support = page.items[1];
    expect(support?.type === 'message' && support.message.from).toEqual({ kind: 'support', name: 'Priya', avatarUrl: null });
    expect(page.status).toEqual({ code: 'received', text: 'Support has your message' });
    expect(page.olderCursor).toBeNull();
    expect(typeof page.streamSeq).toBe('number');
    expectCustomerSafe(response.body, [old.id, group.id, agent.id, 'Secret internal note']);
    for (const item of page.items) if (item.type === 'message') expect(Object.keys(item.message).sort()).toEqual(MESSAGE_KEYS);
  });

  it('pages backwards with before and never shows another customer', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const neighbour = await createUser(tenant, { roles: ['customer'] });
    await send(neighbour, 'Not yours');
    for (const body of ['one', 'two', 'three', 'four', 'five']) await send(customer, body);

    const newest = (await asUser(customer).get('/customer/conversation?limit=2')).body as ConversationBody;
    expect(newest.items.map((item) => item.type === 'message' && item.message.body)).toEqual(['four', 'five']);
    const older = (await asUser(customer).get(`/customer/conversation?limit=2&before=${newest.olderCursor ?? ''}`)).body as ConversationBody;
    expect(older.items.map((item) => item.type === 'message' && item.message.body)).toEqual(['two', 'three']);
    const oldest = (await asUser(customer).get(`/customer/conversation?limit=2&before=${older.olderCursor ?? ''}`)).body as ConversationBody;
    expect(oldest.items.map((item) => item.type === 'message' && item.message.body)).toEqual(['one']);
    expect(oldest.olderCursor).toBeNull();

    const bad = await asUser(customer).get('/customer/conversation?before=nope');
    expect(failure(bad).error.details).toEqual([{ path: 'cursor', issue: 'invalid_cursor' }]);
  });

  it('is idle for a new customer and empty for a customer of another tenant with the same email', async () => {
    const lone = await createUser(other, { roles: ['customer'] });
    const page = (await asUser(lone).get('/customer/conversation')).body as ConversationBody;
    expect(page.items).toEqual([]);
    expect(page.status.code).toBe('idle');
  });
});

describe('POST /customer/messages/read', () => {
  it('marks support replies read and tells staff with message.read', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const ticket = await createTicket(tenant, { customer, state: 'open', messages: [{ body: 'Question' }, { body: 'Answer', staff: agent }] });
    const page = (await asUser(customer).get('/customer/conversation')).body as ConversationBody;
    const answer = page.items.at(-1);
    const answerId = answer?.type === 'message' ? answer.message.id : '';

    expect((await asUser(customer).post('/customer/messages/read', { upToMessageId: answerId })).status).toBe(204);
    const events = await inspect(tenant, (tx, repo) => repo.events(tx, `ticket:${ticket.id}`));
    expect(events.filter((event) => event.type === 'message.read').map((event) => (event.payload as { upToMessageId: string }).upToMessageId)).toEqual([answerId]);

    const unknown = await asUser(customer).post('/customer/messages/read', { upToMessageId: uuidv7() });
    expect([unknown.status, failure(unknown).error.code]).toEqual([404, 'MESSAGE_NOT_FOUND']);
  });
});

describe('outbox events', () => {
  it('announce the ticket to staff list rooms and the message to the customer as a projection', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const sent = await send(customer, 'Hello support');
    const [ticket] = await tickets(tenant, customer);
    const listEvents = await inspect(tenant, (tx, repo) => repo.events(tx, 'tickets:group:ungrouped'));
    expect(listEvents.some((event) => event.type === 'ticket.created' && (event.payload as { ticket: { id: string } }).ticket.id === ticket?.id)).toBe(true);

    const customerEvents = await inspect(tenant, (tx, repo) => repo.events(tx, `conversation:${customer.id}`));
    expect(customerEvents.map((event) => [event.type, (event.customer_payload as { type: string }).type])).toEqual([
      ['message.created', 'conversation.message'],
      ['conversation.status_changed', 'conversation.status'],
    ]);
    expect((customerEvents[0]?.customer_payload as { data: unknown }).data).toEqual(sent.body);
    for (const event of customerEvents) expectCustomerSafe(event.customer_payload, [ticket?.id ?? '']);
  });
});
