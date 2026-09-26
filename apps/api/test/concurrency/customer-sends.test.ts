import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { RateLimiter } from '../../src/platform-kernel/http/rate-limit.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../support/app.js';
import { createTenant, createUser, type TestTenant, type TestUser } from '../support/factories.js';
import { asUser } from '../support/http.js';

/**
 * SC-006: 50 concurrent sends from one customer, 10 of them repeating a `clientMessageId` already
 * used among the other 40, land on exactly one ticket with exactly 40 stored messages — the
 * `pg_advisory_xact_lock` in customer-message-router.ts serializes routing per customer and the
 * idempotent `clientMessageId` lookup absorbs the repeats.
 *
 * The customer-message rate limit (20/min, rate-limit.ts) is a route-level HTTP concern, not part
 * of the router behavior under test here; it would otherwise reject request 21+ regardless of real
 * elapsed time, since it counts against the test's `TestClock` tick rather than wall-clock time.
 * The `RateLimiter` service is resolved from the app's own DI container (support/app.ts:
 * `service()`) and only its `customer-message` policy is stubbed out for this file's app instance,
 * leaving the guard, the `api` policy and every other route's throttling untouched.
 */

class TicketsInspect extends TenantRepository {
  forCustomer(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets').select(['id']).where('customer_id', '=', customerId).execute();
  }

  messages(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['client_message_id']).where('ticket_id', '=', ticketId).execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: TicketsInspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new TicketsInspect(ctx)));
}

let tenant: TestTenant;
let customer: TestUser;

beforeAll(async () => {
  const { app } = await getTestApp();
  const limiter = app.get(RateLimiter);
  const originalConsume = limiter.consume.bind(limiter);
  vi.spyOn(limiter, 'consume').mockImplementation((policy, tenantId, subject) =>
    policy === 'customer-message' ? Promise.resolve() : originalConsume(policy, tenantId, subject),
  );

  tenant = await createTenant();
  customer = await createUser(tenant, { roles: ['customer'] });
});

describe('POST /customer/messages under concurrency', () => {
  it('puts 40 messages from 50 parallel sends (10 repeated clientMessageIds) on exactly one ticket', async () => {
    const uniqueIds = Array.from({ length: 40 }, () => uuidv7());
    const repeatedIds = uniqueIds.slice(0, 10);
    const calls = [...uniqueIds, ...repeatedIds].map((clientMessageId, index) => ({ clientMessageId, body: `concurrent message ${index}` }));

    const responses = await Promise.all(calls.map(({ clientMessageId, body }) => asUser(customer).post('/customer/messages', { body, clientMessageId })));

    for (const response of responses) expect(response.status).toBe(201);

    const tickets = await inspect(tenant, (tx, repo) => repo.forCustomer(tx, customer.id));
    expect(tickets).toHaveLength(1);

    const messages = await inspect(tenant, (tx, repo) => repo.messages(tx, tickets[0]?.id ?? ''));
    expect(messages).toHaveLength(40);
    expect(new Set(messages.map((m) => m.client_message_id))).toEqual(new Set(uniqueIds));
  });
});
