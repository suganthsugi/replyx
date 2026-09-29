import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { RateLimiter } from '../../src/platform-kernel/http/rate-limit.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestGroup, type TestTenant, type TestUser } from '../support/factories.js';
import { asUser } from '../support/http.js';
import { sweeperJob } from '../support/jobs.js';

/**
 * T186 (US7, D10/D11): a customer message and the timer sweeper racing on the same resolved
 * ticket, right at its `auto_close_at`. `lockCustomer` (customer-message-router.ts) and the
 * sweeper's own advisory lock (sweeper.job.ts) take the same lock in the same order, so whichever
 * side wins, the other sees the ticket's true post-race state under the lock: exactly one message
 * is ever stored, and the ticket ends up either reopened (still in grace) or closed with the
 * message on a linked follow-up (grace expired) — never both, and never neither.
 *
 * 100 iterations, one tenant, a fresh customer and ticket each time (so the advisory lock never
 * serializes one iteration behind another): the racing pair inside each iteration is what's
 * parallel, not the iterations themselves.
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

describe('a customer message racing the auto-close sweeper', () => {
  it(`lands the message on exactly one ticket in all ${ITERATIONS} iterations, with a consistent link`, async () => {
    const { clock } = await getTestApp();

    for (let i = 0; i < ITERATIONS; i += 1) {
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, {
        customer,
        group: group.id,
        owner: owner.id,
        state: 'resolved',
        autoCloseAt: clock.now(),
        messages: [{ body: 'Original issue' }],
      });
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

      if (landedTicketId === ticket.id) {
        // Still within grace: the same ticket reopened, group and owner kept, nothing new created.
        expect(original.state).toBe('open');
        expect(original.closed_at).toBeNull();
        expect(original.group_id).toBe(group.id);
        expect(original.owner_id).toBe(owner.id);
        expect(allTickets).toHaveLength(1);
      } else {
        // Grace expired: the original closed exactly once, and the message's ticket is a new
        // follow-up linked back to it (default after_close_behavior).
        expect(original.state).toBe('closed');
        expect(original.closed_at).not.toBeNull();
        expect(allTickets).toHaveLength(2);
        expect(landedTicketId).toBeDefined();
        const followUpId = allTickets.find((row) => row.id !== ticket.id)?.id;
        expect(followUpId).toBe(landedTicketId);
        const links = await inTenant(tenant, (tx, repo) => repo.linksFrom(tx, followUpId as string));
        expect(links).toContainEqual({ kind: 'follow_up_of', to_ticket_id: ticket.id });
      }
    }
  }, 180_000);
});
