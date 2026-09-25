import { beforeAll, describe, expect, it } from 'vitest';

import { CustomerMessageRouter } from '../../../src/messaging/customer-message-router.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';

/**
 * `CustomerMessageRouter.accept` routing decisions (data-model.md "Conversation routing",
 * research.md D10, FR-050/FR-051). The decision is only reachable through the database (advisory
 * lock, row state, tenant settings), so these run against the real Testcontainers Postgres like
 * the integration tests, calling the router directly instead of going through HTTP so each branch
 * can be set up precisely.
 */

interface TicketRowView {
  id: string;
  state: string;
  origin: string;
  group_id: string | null;
  owner_id: string | null;
  waiting_on: string;
}

class Inspect extends TenantRepository {
  tickets(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['id', 'state', 'origin', 'group_id', 'owner_id', 'waiting_on'])
      .where('customer_id', '=', customerId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  links(tx: TenantTransaction, fromTicketId: string) {
    return this.selectFrom(tx, 'ticket_links').select(['to_ticket_id', 'kind']).where('from_ticket_id', '=', fromTicketId).execute();
  }

  /** Bumps `updated_at` past whatever else has happened since, without changing anything else. */
  touch(tx: TenantTransaction, ticketId: string) {
    return this.updateTable(tx, 'tickets').set({ waiting_on: 'support' }).where('id', '=', ticketId).execute();
  }

  setAfterCloseBehavior(tx: TenantTransaction, behavior: 'new_follow_up' | 'reopen_previous') {
    return this.updateTable(tx, 'tenant_settings').set({ after_close_behavior: behavior }).execute();
  }

  /** Simulates the retention purge (D18): the ticket row is gone, as if it never existed. */
  purge(tx: TenantTransaction, ticketId: string) {
    return this.deleteFrom(tx, 'tickets').where('id', '=', ticketId).execute();
  }
}

function systemContext(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-router-inspect' });
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = systemContext(tenant);
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

const tickets = (tenant: TestTenant, customer: TestUser) => inspect(tenant, (tx, repo) => repo.tickets(tx, customer.id)) as Promise<TicketRowView[]>;

/** Calls the router the way the customer controller does, for one customer's own message. */
async function send(tenant: TestTenant, customer: TestUser, body: string): Promise<void> {
  const router = await service(CustomerMessageRouter);
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'user', id: customer.id }, requestId: `test-router-${uuidv7()}` });
  await router.accept(ctx, customer.id, { body, clientMessageId: uuidv7(), attachmentIds: [] });
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
});

describe('CustomerMessageRouter.accept routing', () => {
  it('starts a brand-new ticket when the customer has no prior tickets', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    await send(tenant, customer, 'First contact');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'new', origin: 'customer_message', waiting_on: 'support' });
  });

  it('appends to the customer\'s single active ticket', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const active = await createTicket(tenant, { customer, state: 'open' });
    await send(tenant, customer, 'Still here');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: active.id, state: 'open' });
  });

  it('with several active tickets, appends to the most recently updated one, not the most recently created', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const olderTouched = await createTicket(tenant, { customer, state: 'open' });
    const newerUntouched = await createTicket(tenant, { customer, state: 'pending_reminder' });
    // Touching the older ticket bumps its updated_at past the newer one's.
    await inspect(tenant, (tx, repo) => repo.touch(tx, olderTouched.id));

    await send(tenant, customer, 'Which one gets this?');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === olderTouched.id)).toMatchObject({ state: 'open', waiting_on: 'support' });
    expect(rows.find((row) => row.id === newerUntouched.id)).toMatchObject({ state: 'pending_reminder' });
  });

  it('reopens a resolved ticket within the grace period, keeping its group and owner', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const agent = await createUser(tenant, { roles: ['admin'] });
    const group = await createGroup(tenant);
    const { clock } = await getTestApp();
    const resolved = await createTicket(tenant, {
      customer,
      group: group.id,
      owner: agent.id,
      state: 'resolved',
      now: clock.now(),
      autoCloseAt: new Date(clock.nowMs() + 3_600_000),
    });

    await send(tenant, customer, 'Actually, one more thing');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: resolved.id, state: 'open', group_id: group.id, owner_id: agent.id });
  });

  it('closes a resolved ticket once its grace period has passed, then starts a follow-up (past-grace branch)', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const { clock } = await getTestApp();
    const resolved = await createTicket(tenant, {
      customer,
      state: 'resolved',
      now: clock.now(),
      autoCloseAt: new Date(clock.nowMs() - 1_000),
    });

    await send(tenant, customer, 'New problem after the grace period');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: resolved.id, state: 'closed' });
    expect(rows[1]).toMatchObject({ state: 'new', origin: 'follow_up' });
    expect(await inspect(tenant, (tx, repo) => repo.links(tx, rows[1]?.id ?? ''))).toEqual([{ to_ticket_id: resolved.id, kind: 'follow_up_of' }]);
  });

  it('closed ticket, after_close_behavior = new_follow_up (default): starts a new linked ticket', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const closed = await createTicket(tenant, { customer, state: 'closed' });

    await send(tenant, customer, 'A different issue');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: closed.id, state: 'closed' });
    expect(rows[1]).toMatchObject({ state: 'new', origin: 'follow_up' });
    expect(await inspect(tenant, (tx, repo) => repo.links(tx, rows[1]?.id ?? ''))).toEqual([{ to_ticket_id: closed.id, kind: 'follow_up_of' }]);
  });

  it('closed ticket, after_close_behavior = reopen_previous: reopens the same ticket, keeping group and owner', async () => {
    const reopenTenant = await createTenant();
    await inspect(reopenTenant, (tx, repo) => repo.setAfterCloseBehavior(tx, 'reopen_previous'));
    const customer = await createUser(reopenTenant, { roles: ['customer'] });
    const agent = await createUser(reopenTenant, { roles: ['admin'] });
    const group = await createGroup(reopenTenant);
    const closed = await createTicket(reopenTenant, { customer, group: group.id, owner: agent.id, state: 'closed' });

    await send(reopenTenant, customer, 'Back again');
    const rows = await tickets(reopenTenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: closed.id, state: 'open', group_id: group.id, owner_id: agent.id });
  });

  it('starts a brand-new, unlinked ticket when the customer\'s only prior ticket was purged by retention', async () => {
    const customer = await createUser(tenant, { roles: ['customer'] });
    const purged = await createTicket(tenant, { customer, state: 'closed' });
    await inspect(tenant, (tx, repo) => repo.purge(tx, purged.id));

    await send(tenant, customer, 'Hello again, first time as far as the router can tell');
    const rows = await tickets(tenant, customer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'new', origin: 'customer_message' });
    expect(await inspect(tenant, (tx, repo) => repo.links(tx, rows[0]?.id ?? ''))).toEqual([]);
  });
});
