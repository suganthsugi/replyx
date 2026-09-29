import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * What the customer is told when an agent resolves a ticket (T182, US7 scenario 1,
 * src/messaging/conversation-events.ts `announceResolved`): the live `conversation.resolved` and
 * `conversation.status_changed` events must agree with a reload of `GET /customer/conversation`.
 */

interface ConversationBody {
  items: ({ type: 'message' } | { type: 'resolved_marker'; marker: { id: string } })[];
  status: { code: string; text: string };
}

class Inspect extends TenantRepository {
  events(tx: TenantTransaction, stream: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select(['type', 'customer_payload'])
      .where(sql<boolean>`streams @> ARRAY[${stream}]::text[]`)
      .orderBy('id')
      .execute();
  }

  clearResolvedAt(tx: TenantTransaction, ticketId: string) {
    return this.updateTable(tx, 'tickets').set({ resolved_at: null }).where('id', '=', ticketId).execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

/** The status code the last live `conversation.status_changed` told the customer. */
async function liveStatus(tenant: TestTenant, customerId: string): Promise<string | undefined> {
  const events = await inspect(tenant, (tx, repo) => repo.events(tx, `conversation:${customerId}`));
  const last = events.filter((event) => event.type === 'conversation.status_changed').at(-1);
  return (last?.customer_payload as { data: { code: string } } | undefined)?.data.code;
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
});

describe('resolving a ticket announces to the customer', () => {
  it('sends idle when it was the only active ticket, and the marker matches a reload', async () => {
    const [group, agent, customer] = [await createGroup(tenant), await createUser(tenant, { roles: ['admin'] }), await createUser(tenant, { roles: ['customer'] })];
    const ticket = await createTicket(tenant, { customer, group: group.id, owner: agent.id, state: 'open', messages: [{ body: 'Where is my order?' }] });

    expect((await asUser(agent).patch(`/tickets/${ticket.id}`, { state: 'resolved' })).status).toBe(200);

    const events = await inspect(tenant, (tx, repo) => repo.events(tx, `conversation:${customer.id}`));
    const marker = events.find((event) => event.type === 'conversation.resolved')?.customer_payload as { data: { id: string } };
    expect(marker).toBeDefined();
    expect(await liveStatus(tenant, customer.id)).toBe('idle');

    const reloaded = (await asUser(customer).get('/customer/conversation')).body as ConversationBody;
    expect(reloaded.status.code).toBe('idle');
    const markers = reloaded.items.filter((item) => item.type === 'resolved_marker');
    expect(markers.map((item) => (item as { marker: { id: string } }).marker.id)).toEqual([marker.data.id]);
  });

  it('sends the status of the other active ticket, not idle, so live and reload agree', async () => {
    const [group, agent, customer] = [await createGroup(tenant), await createUser(tenant, { roles: ['admin'] }), await createUser(tenant, { roles: ['customer'] })];
    const resolving = await createTicket(tenant, { customer, group: group.id, owner: agent.id, state: 'open', messages: [{ body: 'First question' }] });
    await createTicket(tenant, { customer, group: group.id, owner: agent.id, state: 'open', messages: [{ body: 'Second question' }] });

    expect((await asUser(agent).patch(`/tickets/${resolving.id}`, { state: 'resolved' })).status).toBe(200);

    const reloaded = (await asUser(customer).get('/customer/conversation')).body as ConversationBody;
    expect(reloaded.status.code).not.toBe('idle');
    expect(await liveStatus(tenant, customer.id)).toBe(reloaded.status.code);
  });

  it('shows no marker for a ticket closed without ever being resolved (live only announces resolutions)', async () => {
    const [group, customer] = [await createGroup(tenant), await createUser(tenant, { roles: ['customer'] })];
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'closed', messages: [{ body: 'Never answered' }] });
    await inspect(tenant, (tx, repo) => repo.clearResolvedAt(tx, ticket.id));

    const reloaded = (await asUser(customer).get('/customer/conversation')).body as ConversationBody;
    expect(reloaded.items.map((item) => item.type)).toEqual(['message']);
  });
});
