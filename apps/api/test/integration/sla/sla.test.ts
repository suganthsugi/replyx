import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { tenantScopeOf } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { SlaSweepRepository } from '../../../src/sla/sla-sweep.js';
import { getTestApp } from '../../support/app.js';
import { createGroup, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { countEventsOfType, sweeperJob } from '../../support/jobs.js';
import {
  createBusinessHours,
  createSlaPolicy,
  deliverToSla,
  inSlaTenant,
  recomputeSla,
  slaEvents,
  slaRow,
  ticketCreatedAt,
  WEEKDAYS_9_TO_17,
} from '../../support/sla.js';

/**
 * SLA timers end to end below the HTTP policy endpoints (T226 part 2; T223 behaviour, FR-084,
 * FR-085, research D15). Policies and calendars are fixture rows (support/sla.ts); the SLA consumer
 * and the sweeper run by hand against the app's TestClock, so every instant is exact.
 *
 * Escalated, the sla_status filter, SlaSummary and the admin endpoints are in sla-views, sla-summary and
 * sla-admin.test.ts (T224).
 */

// A Monday, 10:00 UTC.
const T0 = new Date('2026-03-09T10:00:00.000Z');
const MINUTE = 60_000;
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

interface World {
  tenant: TestTenant;
  admin: TestUser;
  customer: TestUser;
}

async function world(): Promise<World> {
  const tenant = await createTenant({ timezone: 'UTC' });
  const [admin, customer] = await Promise.all([createUser(tenant, { roles: ['admin'] }), createUser(tenant, { roles: ['customer'] })]);
  return { tenant, admin, customer };
}

async function clock() {
  return (await getTestApp()).clock;
}

async function sweep(): Promise<void> {
  await (await sweeperJob()).process();
}

const countOf = (tenant: TestTenant, type: string) => countEventsOfType(tenant.id, type);

beforeEach(async () => {
  (await clock()).set(T0);
});

describe('policy matching on ticket creation', () => {
  it('creates a ticket_sla row for a staff-started urgent ticket; first response is already met by the opening message', async () => {
    const { tenant, admin, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, {
      businessHours: hours,
      name: 'urgent: first response 15 minutes',
      conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: 'urgent' }] },
      firstResponseMinutes: 15,
      resolutionMinutes: 240,
      warningPercent: 80,
    });

    const response = await asUser(admin).post('/tickets', {
      customerId: customer.id,
      groupId: group.id,
      title: 'Printer on fire',
      message: { body: 'Please help' },
      priority: 'urgent',
    });
    expect(response.status).toBe(201);
    const ticketId = (response.body as { id: string }).id;
    expect(await slaRow(tenant, ticketId)).toBeUndefined(); // nothing until the consumer runs

    expect(await deliverToSla(tenant, 'ticket.created')).toBe('handled');

    const created = await ticketCreatedAt(tenant, ticketId);
    expect(await slaRow(tenant, ticketId)).toMatchObject({
      policyId: policy.id,
      status: 'ok',
      pausedSince: null,
      firstResponseDueAt: null, // staff-started tickets count as replied from the start
      firstResponseWarnAt: null,
      nextResponseDueAt: null,
      resolutionDueAt: at(created, 240),
      resolutionWarnAt: at(created, 192),
    });
  });

  it('a customer message that opens a ticket gets first-response due and warn times', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    const policy = await createSlaPolicy(tenant, { businessHours: hours, name: 'first response 15 minutes', firstResponseMinutes: 15, warningPercent: 80 });
    const sent = await asUser(customer).post('/customer/messages', { body: 'Anyone there?', clientMessageId: uuidv7() });
    expect(sent.status).toBe(201);
    const ticketId = await inSlaTenant(tenant, async (tx) => {
      const row = await sql<{ id: string }>`SELECT id FROM tickets`.execute(tx);
      return row.rows[0]?.id ?? '';
    });
    expect(await deliverToSla(tenant, 'ticket.created')).toBe('handled');
    const created = await ticketCreatedAt(tenant, ticketId);
    expect(await slaRow(tenant, ticketId)).toMatchObject({
      policyId: policy.id,
      status: 'ok',
      firstResponseDueAt: at(created, 15),
      firstResponseWarnAt: at(created, 12),
    });
  });

  it('leaves a ticket without a row when no policy matches it', async () => {
    const { tenant, admin, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, {
      businessHours: hours,
      conditions: { op: 'and', items: [{ field: 'priority', operator: 'is', value: 'urgent' }] },
      firstResponseMinutes: 15,
    });

    const response = await asUser(admin).post('/tickets', { customerId: customer.id, groupId: group.id, title: 'Slow wifi', message: { body: 'Hi' }, priority: 'low' });
    expect(response.status).toBe(201);
    await deliverToSla(tenant, 'ticket.created');
    expect(await slaRow(tenant, (response.body as { id: string }).id)).toBeUndefined();
  });

  it('applies the first matching policy by position, not by creation order', async () => {
    const { tenant, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    const catchAll = await createSlaPolicy(tenant, { businessHours: hours, name: 'catch-all', position: 5, firstResponseMinutes: 120 });
    const forGroup = await createSlaPolicy(tenant, {
      businessHours: hours,
      name: 'group',
      position: 1,
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group.id }] },
      firstResponseMinutes: 30,
    });
    const first = await createTicket(tenant, { customer, group: group.id, now: T0, messages: [{ body: 'a' }] });
    const other = await createTicket(tenant, { customer, now: T0, messages: [{ body: 'b' }] }); // ungrouped: the group policy never matches it

    expect(await recomputeSla(tenant, first.id)).toBe('created');
    expect(await recomputeSla(tenant, other.id)).toBe('created');
    expect(await slaRow(tenant, first.id)).toMatchObject({ policyId: forGroup.id, firstResponseDueAt: at(T0, 30) });
    expect(await slaRow(tenant, other.id)).toMatchObject({ policyId: catchAll.id, firstResponseDueAt: at(T0, 120) });
  });

  it('removes the row when the ticket stops matching any policy (after a group change)', async () => {
    const { tenant, admin, customer } = await world();
    const [g1, g2] = [await createGroup(tenant), await createGroup(tenant)];
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, {
      businessHours: hours,
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: g1.id }] },
      firstResponseMinutes: 30,
    });
    const ticket = await createTicket(tenant, { customer, group: g1.id, now: T0, messages: [{ body: 'a' }] });
    await recomputeSla(tenant, ticket.id);
    expect(await slaRow(tenant, ticket.id)).toBeDefined();

    const moved = await asUser(admin).patch(`/tickets/${ticket.id}`, { groupId: g2.id });
    expect(moved.status).toBe(200);
    await deliverToSla(tenant, 'ticket.updated');
    expect(await slaRow(tenant, ticket.id)).toBeUndefined();
  });

  it('computes due times on the policy business-hours calendar', async () => {
    const { tenant, customer } = await world();
    // Friday 16:30 UTC + 60 business minutes on Mon-Fri 09-17 = Monday 09:30.
    const friday = new Date('2026-03-06T16:30:00.000Z');
    (await clock()).set(friday);
    const hours = await createBusinessHours(tenant, { intervals: WEEKDAYS_9_TO_17 });
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, now: friday, messages: [{ body: 'a' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(new Date('2026-03-09T09:30:00.000Z'));
  });
});

describe('sweeper: warning and breach exactly once', () => {
  it('emits sla.warning at the warn time and sla.breached at the due time, each once however often the sweeper runs', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60, warningPercent: 80 });
    const ticket = await createTicket(tenant, { customer, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 47)); // before the warn time (48 min)
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(0);
    expect((await slaRow(tenant, ticket.id))?.status).toBe('ok');

    (await clock()).set(at(T0, 50));
    await sweep();
    await sweep();
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(1);
    expect(await countOf(tenant, 'sla.breached')).toBe(0);
    expect((await slaRow(tenant, ticket.id))?.status).toBe('warning');
    expect(await slaEvents(tenant, ticket.id)).toEqual([{ target: 'first_response', kind: 'warning', occurredAt: at(T0, 48) }]);

    (await clock()).set(at(T0, 61));
    await sweep();
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(1);
    expect(await countOf(tenant, 'sla.breached')).toBe(1);
    expect((await slaRow(tenant, ticket.id))?.status).toBe('breached');
    expect(await slaEvents(tenant, ticket.id)).toEqual([
      { target: 'first_response', kind: 'warning', occurredAt: at(T0, 48) },
      { target: 'first_response', kind: 'breached', occurredAt: at(T0, 60) },
    ]);

    (await clock()).advance(24 * 60 * MINUTE);
    await sweep();
    expect(await countOf(tenant, 'sla.breached')).toBe(1);
  });

  it('announces only the breach when the sweeper first sees a target already overdue, and never warns later', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 90));
    await sweep();
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(0);
    expect(await countOf(tenant, 'sla.breached')).toBe(1);
    // The warning row is recorded silently so it can't fire later.
    expect((await slaEvents(tenant, ticket.id)).map((e) => `${e.target}:${e.kind}`).sort()).toEqual(['first_response:breached', 'first_response:warning']);
  });

  it('tracks each target separately: first response and resolution warn and breach independently', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30, resolutionMinutes: 100, warningPercent: 80 });
    const ticket = await createTicket(tenant, { customer, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 25)); // first response warns (24)
    await sweep();
    (await clock()).set(at(T0, 85)); // first response breached (30), resolution warns (80)
    await sweep();
    (await clock()).set(at(T0, 101)); // resolution breached (100)
    await sweep();
    await sweep();

    const events = (await slaEvents(tenant, ticket.id)).map((e) => `${e.target}:${e.kind}`).sort();
    expect(events).toEqual(['first_response:breached', 'first_response:warning', 'resolution:breached', 'resolution:warning']);
    expect(await countOf(tenant, 'sla.warning')).toBe(2);
    expect(await countOf(tenant, 'sla.breached')).toBe(2);
  });

  it('respects the sla_events unique key: a second record of the same ticket, target and kind is refused', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    (await clock()).set(at(T0, 50));
    await sweep();

    const again = await inSlaTenant(tenant, (tx) => {
      const ctx = tenantScopeOf(tx);
      if (ctx === undefined) throw new Error('no scope');
      return new SlaSweepRepository(ctx).record(tx, ticket.id, 'first_response', 'warning', at(T0, 48));
    });
    expect(again).toBe(false);
    expect(await slaEvents(tenant, ticket.id)).toHaveLength(1);
  });

  it('does not warn or breach for a policy-less ticket or another tenant', async () => {
    const a = await world();
    const b = await world();
    const hours = await createBusinessHours(a.tenant);
    await createSlaPolicy(a.tenant, { businessHours: hours, firstResponseMinutes: 10 });
    const ticketB = await createTicket(b.tenant, { customer: b.customer, now: T0, messages: [{ body: 'x' }] });
    await recomputeSla(b.tenant, ticketB.id);
    (await clock()).set(at(T0, 60));
    await sweep();
    expect(await slaRow(b.tenant, ticketB.id)).toBeUndefined();
    expect(await countOf(b.tenant, 'sla.breached')).toBe(0);
    expect(await countOf(a.tenant, 'sla.breached')).toBe(0); // A has no ticket
  });
});

describe('responses and resolution', () => {
  it('a public staff reply meets first response: no breach follows', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(T0, 30));

    (await clock()).set(at(T0, 10));
    const reply = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'On it', clientMessageId: uuidv7() });
    expect(reply.status).toBe(201);
    await deliverToSla(tenant, 'message.created');

    expect(await slaRow(tenant, ticket.id)).toMatchObject({ firstResponseDueAt: null, firstResponseWarnAt: null, status: 'ok' });
    (await clock()).set(at(T0, 120));
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(0);
    expect(await countOf(tenant, 'sla.breached')).toBe(0);
  });

  it('an internal note does not meet first response', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 10));
    const note = await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'internal', body: 'Looking', clientMessageId: uuidv7() });
    expect(note.status).toBe(201);
    expect(await deliverToSla(tenant, 'message.created')).toBe('handled'); // delivered, but internal notes never count
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(T0, 30));

    // Even a forced recompute from the ticket's facts keeps the target open.
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(T0, 30));

    (await clock()).set(at(T0, 31));
    await sweep();
    expect(await countOf(tenant, 'sla.breached')).toBe(1);
  });

  it('starts next response at the customer message after a staff reply, and a staff reply ends it', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30, nextResponseMinutes: 20 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.nextResponseDueAt).toBeNull(); // before the first reply, first response covers the customer

    (await clock()).set(at(T0, 5));
    await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Hi', clientMessageId: uuidv7() });
    await deliverToSla(tenant, 'message.created');
    expect((await slaRow(tenant, ticket.id))?.nextResponseDueAt).toBeNull();

    (await clock()).set(at(T0, 15));
    const sent = await asUser(customer).post('/customer/messages', { body: 'Any news?', clientMessageId: uuidv7() });
    expect(sent.status).toBe(201);
    await deliverToSla(tenant, 'message.created');
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ nextResponseDueAt: at(T0, 35), nextResponseWarnAt: at(T0, 31) });

    (await clock()).set(at(T0, 20));
    await asUser(admin).post(`/tickets/${ticket.id}/messages`, { visibility: 'public', body: 'Update', clientMessageId: uuidv7() });
    await deliverToSla(tenant, 'message.created');
    expect((await slaRow(tenant, ticket.id))?.nextResponseDueAt).toBeNull();
  });

  it('pending_close pauses resolution; leaving it moves the due and warn times by the paused minutes', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 100, warningPercent: 80 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.resolutionDueAt).toEqual(at(T0, 100));

    (await clock()).set(at(T0, 40));
    const paused = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_close', pendingUntil: at(T0, 60 * 24 * 5).toISOString() });
    expect(paused.status).toBe(200);
    await deliverToSla(tenant, 'ticket.state_changed');
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ pausedSince: at(T0, 40), resolutionDueAt: at(T0, 100) });

    // Long past the original due time and warning: a paused timer never fires.
    (await clock()).set(at(T0, 300));
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(0);
    expect(await countOf(tenant, 'sla.breached')).toBe(0);

    // Resume 260 minutes after the pause began.
    const resumed = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'open' });
    expect(resumed.status).toBe(200);
    await deliverToSla(tenant, 'ticket.state_changed');
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ pausedSince: null, resolutionDueAt: at(T0, 360), resolutionWarnAt: at(T0, 340) });
  });

  it('pending_reminder pauses resolution the same way', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 100 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 10));
    const paused = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'pending_reminder', pendingUntil: at(T0, 60 * 24 * 5).toISOString() });
    expect(paused.status).toBe(200);
    await deliverToSla(tenant, 'ticket.state_changed');
    expect((await slaRow(tenant, ticket.id))?.pausedSince).toEqual(at(T0, 10));

    (await clock()).set(at(T0, 30));
    await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'open' });
    await deliverToSla(tenant, 'ticket.state_changed');
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ pausedSince: null, resolutionDueAt: at(T0, 120) });
  });

  it('a resolved ticket has no running timers and the sweeper stays silent', async () => {
    const { tenant, admin, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30, resolutionMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, owner: admin.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 10));
    const resolved = await asUser(admin).patch(`/tickets/${ticket.id}`, { state: 'resolved' });
    expect(resolved.status).toBe(200);
    await deliverToSla(tenant, 'ticket.state_changed');
    expect(await slaRow(tenant, ticket.id)).toMatchObject({
      status: 'ok',
      firstResponseDueAt: null,
      resolutionDueAt: null,
      resolutionWarnAt: null,
      pausedSince: null,
    });

    (await clock()).set(at(T0, 600));
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(0);
    expect(await countOf(tenant, 'sla.breached')).toBe(0);
  });

  it('a closed ticket never breaches even if its row predates the close', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, resolutionMinutes: 30 });
    const open = await createTicket(tenant, { customer, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, open.id);
    // Close it behind the consumer's back: the sweeper still must not breach a closed ticket.
    await inSlaTenant(tenant, async (tx) => {
      await sql`UPDATE tickets SET state = 'closed', closed_at = ${T0}, resolved_at = ${T0} WHERE id = ${open.id}`.execute(tx);
    });
    (await clock()).set(at(T0, 120));
    await sweep();
    expect(await countOf(tenant, 'sla.breached')).toBe(0);
  });
});

describe('time spent Ungrouped counts (FR-085)', () => {
  it('starts the timers at creation, so a ticket still ungrouped warns and breaches on schedule', async () => {
    const { tenant, customer } = await world();
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60 });
    const ticket = await createTicket(tenant, { customer, group: null, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    expect((await slaRow(tenant, ticket.id))?.firstResponseDueAt).toEqual(at(T0, 60));

    (await clock()).set(at(T0, 50));
    await sweep();
    expect(await countOf(tenant, 'sla.warning')).toBe(1);
    (await clock()).set(at(T0, 61));
    await sweep();
    expect(await countOf(tenant, 'sla.breached')).toBe(1);
  });

  it('keeps the creation-based due time when the ticket is grouped later', async () => {
    const { tenant, admin, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60, resolutionMinutes: 120 });
    const ticket = await createTicket(tenant, { customer, group: null, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    (await clock()).set(at(T0, 45)); // 45 minutes ungrouped
    const grouped = await asUser(admin).patch(`/tickets/${ticket.id}`, { groupId: group.id });
    expect(grouped.status).toBe(200);
    await deliverToSla(tenant, 'ticket.updated');

    // Not restarted at grouping: 15 minutes are left of the original 60.
    expect(await slaRow(tenant, ticket.id)).toMatchObject({ firstResponseDueAt: at(T0, 60), resolutionDueAt: at(T0, 120) });
  });

  it('a policy limited to Ungrouped tickets matches them, and a group policy does not', async () => {
    const { tenant, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    const forGroup = await createSlaPolicy(tenant, {
      businessHours: hours,
      position: 0,
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group.id }] },
      firstResponseMinutes: 10,
    });
    const forUngrouped = await createSlaPolicy(tenant, {
      businessHours: hours,
      position: 1,
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: 'ungrouped' }] },
      firstResponseMinutes: 45,
    });
    const ticket = await createTicket(tenant, { customer, group: null, now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);
    const row = await slaRow(tenant, ticket.id);
    expect(row?.policyId).toBe(forUngrouped.id);
    expect(row?.policyId).not.toBe(forGroup.id);
    expect(row?.firstResponseDueAt).toEqual(at(T0, 45));
  });
});

describe('sweeper and consumer idempotency', () => {
  it('redelivering the same event to the SLA consumer changes nothing', async () => {
    const { tenant, admin, customer } = await world();
    const group = await createGroup(tenant);
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 30 });
    const created = await asUser(admin).post('/tickets', { customerId: customer.id, groupId: group.id, title: 'Hi', message: { body: 'x' } });
    expect(created.status).toBe(201);
    const ticketId = (created.body as { id: string }).id;
    expect(await deliverToSla(tenant, 'ticket.created')).toBe('handled');
    const before = await slaRow(tenant, ticketId);
    expect(await deliverToSla(tenant, 'ticket.created')).toBe('skipped');
    expect(await slaRow(tenant, ticketId)).toEqual(before);
    expect(await countOf(tenant, 'sla.updated')).toBe(1);
  });
});
