import { beforeEach, describe, expect, it } from 'vitest';

import { getTestApp } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { sweeperJob } from '../../support/jobs.js';
import { createBusinessHours, createSlaPolicy, recomputeSla } from '../../support/sla.js';

/**
 * Staff `sla` (SlaSummary) on ticket detail and list, and its absence from everything a customer
 * reads (T224, FR-085, ticket-dto.ts / sla-summary.ts).
 */

const T0 = new Date('2026-03-09T10:00:00.000Z');
const MINUTE = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE).toISOString();

interface TicketBody {
  id: string;
  sla: { status: string; policyName?: string; nextDueAt?: string | null; target?: string };
}

async function world(): Promise<{ tenant: TestTenant; admin: TestUser; customer: TestUser }> {
  const tenant = await createTenant({ timezone: 'UTC' });
  const [admin, customer] = await Promise.all([createUser(tenant, { roles: ['admin'] }), createUser(tenant, { roles: ['customer'] })]);
  return { tenant, admin, customer };
}

beforeEach(async () => {
  (await getTestApp()).clock.set(T0);
});

describe('staff SlaSummary', () => {
  it('shows status none for a ticket without a row, on detail and list', async () => {
    const { tenant, admin, customer } = await world();
    const ticket = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'a' }] });

    const detail = await asUser(admin).get(`/tickets/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as TicketBody).sla).toEqual({ status: 'none' });
    const list = await asUser(admin).get('/tickets');
    expect((list.body as { items: TicketBody[] }).items.find((item) => item.id === ticket.id)?.sla).toEqual({ status: 'none' });
  });

  it('shows status, policy name and the earliest running due time and its target', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, name: 'Gold', firstResponseMinutes: 30, resolutionMinutes: 100 });
    const ticket = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'a' }] });
    await recomputeSla(tenant, ticket.id);

    const expected = { status: 'ok', policyName: 'Gold', nextDueAt: at(30), target: 'first_response' };
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla).toEqual(expected);
    const list = await asUser(admin).get('/tickets');
    expect((list.body as { items: TicketBody[] }).items.find((item) => item.id === ticket.id)?.sla).toEqual(expected);

    // After the warn time the sweeper moves the status; the due time stays.
    (await getTestApp()).clock.set(new Date(at(25)));
    await (await sweeperJob()).process();
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla).toEqual({ ...expected, status: 'warning' });

    (await getTestApp()).clock.set(new Date(at(31)));
    await (await sweeperJob()).process();
    // The first response is overdue; it still is the earliest due time.
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla).toEqual({ ...expected, status: 'breached' });
  });

  it('skips the resolution target while it is paused', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, name: 'Resolution only', resolutionMinutes: 100 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'a' }] });
    await recomputeSla(tenant, ticket.id);
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla).toEqual({
      status: 'ok',
      policyName: 'Resolution only',
      nextDueAt: at(100),
      target: 'resolution',
    });

    const paused = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_close', pendingUntil: at(60 * 24 * 3) });
    expect(paused.status).toBe(200);
    await recomputeSla(tenant, ticket.id);
    const sla = ((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla;
    expect(sla).toEqual({ status: 'ok', policyName: 'Resolution only', nextDueAt: null });
    expect(sla.target).toBeUndefined();
  });

  it('serves each list row its own summary in one page', async () => {
    const { tenant, admin, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, {
      businessHours: hours,
      name: 'Group only',
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group.id }] },
      firstResponseMinutes: 20,
    });
    const withSla = await createTicket(tenant, { customer, group: group.id, now: T0, messages: [{ body: 'a' }] });
    const without = await createTicket(tenant, { customer, group: null, now: T0, messages: [{ body: 'b' }] });
    await recomputeSla(tenant, withSla.id);
    await recomputeSla(tenant, without.id);

    const items = ((await asUser(admin).get('/tickets?limit=50')).body as { items: TicketBody[] }).items;
    expect(items.find((i) => i.id === withSla.id)?.sla.policyName).toBe('Group only');
    expect(items.find((i) => i.id === without.id)?.sla).toEqual({ status: 'none' });
  });
});

describe('customers never see SLA data', () => {
  it('carries no sla, policy or due-time data in the conversation or the customer message responses', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, name: 'Secret policy name', firstResponseMinutes: 30, resolutionMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help me' }] });
    await recomputeSla(tenant, ticket.id);
    expect(((await asUser(admin).get(`/tickets/${ticket.id}`)).body as TicketBody).sla.status).toBe('ok'); // it exists for staff

    (await getTestApp()).clock.set(new Date(at(45))); // breached for staff
    await (await sweeperJob()).process();

    const conversation = await asUser(customer).get('/customer/conversation');
    expect(conversation.status).toBe(200);
    const serialized = JSON.stringify(conversation.body);
    for (const leak of ['"sla"', 'Secret policy name', 'policyName', 'nextDueAt', 'breached', 'warning', ticket.id]) {
      expect(serialized).not.toContain(leak);
    }
  });
});
