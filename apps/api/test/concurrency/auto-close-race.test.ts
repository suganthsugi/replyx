import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { RateLimiter } from '../../src/platform-kernel/http/rate-limit.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { getTestApp, service, TestClock } from '../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestGroup, type TestTenant, type TestUser } from '../support/factories.js';
import { asUser } from '../support/http.js';
import { drainOutbox, sweeperJob } from '../support/jobs.js';

/**
 * T186 (US7, D10/D11): a customer message and the timer sweeper on the same resolved ticket around
 * its `auto_close_at`. `lockCustomer` (customer-message-router.ts) and the sweeper's own advisory
 * lock (sweeper.job.ts) take the same lock in the same order, so whichever side wins, the other
 * sees the ticket's true post-race state under the lock. Two variants, each 100 iterations with a
 * fresh customer and ticket (so the advisory lock never serializes one iteration behind another):
 * the racing pair inside an iteration is what's parallel, not the iterations themselves.
 *
 * 1. Expired (`auto_close_at == now`): the router's grace check is `now < auto_close_at`, so the
 *    message can never win; it and the sweeper both try to close the ticket. Whoever gets the lock
 *    first closes it, the other must find it already closed: exactly one `ticket.closed` event and
 *    one `state` history row for the original, and the message lands on a linked follow-up.
 * 2. Grace edge (`auto_close_at == now + 1 s`): the router (app clock, `now`) still sees grace,
 *    while the sweeper runs on its own clock two seconds ahead and sees the ticket as due. Now
 *    either side can win: the message reopens the ticket and the sweeper must find it reopened and
 *    leave it alone, or the sweeper closes it first and the message goes to a follow-up. Never both.
 *
 * Both variants assert that each message is stored exactly once, on exactly one ticket.
 */

class RaceInspect extends TenantRepository {
  ticket(tx: TenantTransaction, id: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.state', 'tickets.closed_at', 'tickets.group_id', 'tickets.owner_id'])
      .where('tickets.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  ticketsForCustomer(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select(['tickets.id', 'tickets.state']).where('tickets.customer_id', '=', customerId).execute();
  }

  messagesFor(tx: TenantTransaction, clientMessageId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['ticket_messages.id', 'ticket_messages.ticket_id']).where('ticket_messages.client_message_id', '=', clientMessageId).execute();
  }

  linksFrom(tx: TenantTransaction, fromTicketId: string) {
    return this.selectFrom(tx, 'ticket_links').select(['ticket_links.kind', 'ticket_links.to_ticket_id']).where('ticket_links.from_ticket_id', '=', fromTicketId).execute();
  }

  async closedEvents(tx: TenantTransaction, ticketId: string): Promise<number> {
    const rows = await this.selectFrom(tx, 'outbox_events')
      .select(['outbox_events.id', 'outbox_events.payload'])
      .where('outbox_events.type', '=', 'ticket.closed')
      .execute();
    return rows.filter((row) => (row.payload as { ticketId?: string }).ticketId === ticketId).length;
  }

  async stateHistoryRows(tx: TenantTransaction, ticketId: string): Promise<number> {
    const rows = await this.selectFrom(tx, 'ticket_history')
      .select('ticket_history.id')
      .where('ticket_history.ticket_id', '=', ticketId)
      .where('ticket_history.field', '=', 'state')
      .execute();
    return rows.length;
  }
}

async function inTenant<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: RaceInspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-auto-close-race' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new RaceInspect(ctx)));
}

let tenant: TestTenant;
let group: TestGroup;
let owner: TestUser;

const ITERATIONS = 100;

beforeAll(async () => {
  const { app } = await getTestApp();
  // Same reasoning as test/concurrency/customer-sends.test.ts: the per-route rate limit is an
  // HTTP concern unrelated to the router/sweeper race under test, and would reject requests well
  // before 100 iterations since it counts against the shared TestClock instant.
  const limiter = app.get(RateLimiter);
  const originalConsume = limiter.consume.bind(limiter);
  vi.spyOn(limiter, 'consume').mockImplementation((policy, tenantId, subject) =>
    policy === 'customer-message' ? Promise.resolve() : originalConsume(policy, tenantId, subject),
  );

  tenant = await createTenant();
  group = await createGroup(tenant);
  owner = await createUser(tenant, { roles: ['admin'] });
});

// The outbox is database-wide and this file appends hundreds of events without a worker. Left
// unpublished, they make the next file's relay spend far longer than its socket waits on the
// backlog (resolution.test.ts timed out that way), so publish them before handing over.
afterAll(async () => {
  await drainOutbox();
}, 240_000);

async function resolvedTicket(autoCloseAt: Date) {
  const customer = await createUser(tenant, { roles: ['customer'] });
  const ticket = await createTicket(tenant, {
    customer,
    group: group.id,
    owner: owner.id,
    state: 'resolved',
    autoCloseAt,
    messages: [{ body: 'Original issue' }],
  });
  return { customer, ticket };
}

describe('a customer message racing the auto-close sweeper', () => {
  it(`closes an expired ticket exactly once and follows up on a linked ticket in all ${ITERATIONS} iterations`, async () => {
    const { clock } = await getTestApp();

    for (let i = 0; i < ITERATIONS; i += 1) {
      const { customer, ticket } = await resolvedTicket(clock.now());
      const clientMessageId = uuidv7();

      const job = await sweeperJob();
      const [, sent] = await Promise.all([job.process(), asUser(customer).post('/customer/messages', { body: 'Are you still there?', clientMessageId })]);
      expect(sent.status).toBe(201);

      // Exactly one message ever stored for this send, on exactly one ticket.
      const messages = await inTenant(tenant, (tx, repo) => repo.messagesFor(tx, clientMessageId));
      expect(messages).toHaveLength(1);
      const landedTicketId = messages[0]?.ticket_id;

      const original = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
      const allTickets = await inTenant(tenant, (tx, repo) => repo.ticketsForCustomer(tx, customer.id));

      // Grace had already expired, so the message can only have gone to a follow-up.
      expect(original.state).toBe('closed');
      expect(original.closed_at).not.toBeNull();
      expect(allTickets).toHaveLength(2);
      const followUpId = allTickets.find((row) => row.id !== ticket.id)?.id;
      expect(followUpId).toBeDefined();
      expect(landedTicketId).toBe(followUpId);
      const links = await inTenant(tenant, (tx, repo) => repo.linksFrom(tx, followUpId as string));
      expect(links).toContainEqual({ kind: 'follow_up_of', to_ticket_id: ticket.id });

      // Sweeper and router both tried to close it; only one close was recorded.
      expect(await inTenant(tenant, (tx, repo) => repo.closedEvents(tx, ticket.id))).toBe(1);
      expect(await inTenant(tenant, (tx, repo) => repo.stateHistoryRows(tx, ticket.id))).toBe(1);
    }
  }, 180_000);

  it(`never closes a ticket the message reopened, nor loses the message, in all ${ITERATIONS} grace-edge iterations`, async () => {
    const { clock } = await getTestApp();
    let reopenedCount = 0;
    let followUpCount = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const now = clock.now();
      const { customer, ticket } = await resolvedTicket(new Date(now.getTime() + 1_000));
      const clientMessageId = uuidv7();

      // The sweeper's clock is ahead of the router's: it sees the ticket as due, the router as in grace.
      const sweeperClock = new TestClock();
      sweeperClock.set(new Date(now.getTime() + 2_000));
      const job = await sweeperJob(sweeperClock);
      const [, sent] = await Promise.all([job.process(), asUser(customer).post('/customer/messages', { body: 'Are you still there?', clientMessageId })]);
      expect(sent.status).toBe(201);

      const messages = await inTenant(tenant, (tx, repo) => repo.messagesFor(tx, clientMessageId));
      expect(messages).toHaveLength(1);
      const landedTicketId = messages[0]?.ticket_id;

      const original = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
      const allTickets = await inTenant(tenant, (tx, repo) => repo.ticketsForCustomer(tx, customer.id));
      const closedEvents = await inTenant(tenant, (tx, repo) => repo.closedEvents(tx, ticket.id));

      if (landedTicketId === ticket.id) {
        // The message won the lock: reopened, group and owner kept, and the sweeper left it alone.
        reopenedCount += 1;
        expect(original.state).toBe('open');
        expect(original.closed_at).toBeNull();
        expect(original.group_id).toBe(group.id);
        expect(original.owner_id).toBe(owner.id);
        expect(allTickets).toHaveLength(1);
        expect(closedEvents).toBe(0);
      } else {
        // The sweeper won the lock: closed exactly once, the message on a linked follow-up.
        followUpCount += 1;
        expect(original.state).toBe('closed');
        expect(original.closed_at).not.toBeNull();
        expect(allTickets).toHaveLength(2);
        const followUpId = allTickets.find((row) => row.id !== ticket.id)?.id;
        expect(followUpId).toBe(landedTicketId);
        const links = await inTenant(tenant, (tx, repo) => repo.linksFrom(tx, followUpId as string));
        expect(links).toContainEqual({ kind: 'follow_up_of', to_ticket_id: ticket.id });
        expect(closedEvents).toBe(1);
      }
    }
    expect(reopenedCount + followUpCount).toBe(ITERATIONS);
  }, 180_000);

  it('leaves a reopened ticket open when the sweeper runs after the message won', async () => {
    const { clock } = await getTestApp();
    const now = clock.now();
    const { customer, ticket } = await resolvedTicket(new Date(now.getTime() + 1_000));
    const clientMessageId = uuidv7();

    const sent = await asUser(customer).post('/customer/messages', { body: 'Still here', clientMessageId });
    expect(sent.status).toBe(201);
    expect((await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id))).state).toBe('open');

    // A sweeper whose clock is past the old auto_close_at finds a reopened ticket: it is not due.
    const sweeperClock = new TestClock();
    sweeperClock.set(new Date(now.getTime() + 60_000));
    await (await sweeperJob(sweeperClock)).process();

    const after = await inTenant(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    expect(after.state).toBe('open');
    expect(after.closed_at).toBeNull();
    expect((await inTenant(tenant, (tx, repo) => repo.messagesFor(tx, clientMessageId)))[0]?.ticket_id).toBe(ticket.id);
    expect(await inTenant(tenant, (tx, repo) => repo.closedEvents(tx, ticket.id))).toBe(0);
    expect(await inTenant(tenant, (tx, repo) => repo.ticketsForCustomer(tx, customer.id))).toHaveLength(1);
  });
});
