import { beforeEach, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, setGroupAccess, type TestTenant, type TestUser } from '../../support/factories.js';
import { asGuest, asUser } from '../../support/http.js';

/**
 * `GET /dashboard` (T226, FR-086, US12): live figures over the tickets the caller may view.
 * Tickets are inserted directly (factory plus a column patch) so every state, owner, priority and
 * timestamp is exact; `ticket_sla` rows are inserted directly to stay independent of the SLA consumer.
 */

const NOW = new Date('2026-03-10T15:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type TicketState = 'new' | 'open' | 'pending_reminder' | 'pending_close' | 'resolved' | 'closed';

interface DashboardBody {
  counts: Record<string, number>;
  today: { created: number; resolved: number };
  averages: { firstResponseMinutes: number | null; resolutionMinutes: number | null; window: string };
  satisfaction: { average: number | null; responses: number };
}

const EMPTY: DashboardBody = {
  counts: { open: 0, ungrouped: 0, unassigned: 0, waitingOnCustomer: 0, waitingOnSupport: 0, urgent: 0, slaBreached: 0 },
  today: { created: 0, resolved: 0 },
  averages: { firstResponseMinutes: null, resolutionMinutes: null, window: 'P7D' },
  satisfaction: { average: null, responses: 0 },
};

interface Spec {
  state: TicketState;
  group?: string | null;
  owner?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  waitingOn?: 'support' | 'customer';
  createdAt?: Date;
  resolvedAt?: Date | null;
  firstReplyAt?: Date | null;
  sla?: 'ok' | 'warning' | 'breached';
}

class DashboardFixtureRepository extends TenantRepository {
  async patch(tx: TenantTransaction, id: string, spec: Spec): Promise<void> {
    await this.updateTable(tx, 'tickets')
      .set({
        priority: spec.priority ?? 'normal',
        waiting_on: spec.waitingOn ?? 'support',
        resolved_at: spec.resolvedAt === undefined ? null : spec.resolvedAt,
        first_agent_reply_at: spec.firstReplyAt ?? null,
      })
      .where('tickets.id', '=', id)
      .execute();
  }

  async policyId(tx: TenantTransaction): Promise<string> {
    const existing = await this.selectFrom(tx, 'sla_policies').select('sla_policies.id').executeTakeFirst();
    if (existing !== undefined) return existing.id;
    const calendar = await this.insertInto(tx, 'business_hours', { name: 'Fixture hours', timezone: 'UTC' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const policy = await this.insertInto(tx, 'sla_policies', { name: 'Fixture policy', business_hours_id: calendar.id, resolution_minutes: 60 })
      .returning('id')
      .executeTakeFirstOrThrow();
    return policy.id;
  }

  async insertSla(tx: TenantTransaction, ticketId: string, status: 'ok' | 'warning' | 'breached'): Promise<void> {
    const policyId = await this.policyId(tx);
    await this.insertInto(tx, 'ticket_sla', { ticket_id: ticketId, policy_id: policyId, status }).execute();
  }
}

async function unitOfWork(tenant: TestTenant, fn: (tx: TenantTransaction, repo: DashboardFixtureRepository) => Promise<void>): Promise<void> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'dashboard-test' });
  await (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new DashboardFixtureRepository(ctx)));
}

async function ticket(tenant: TestTenant, customer: TestUser, spec: Spec): Promise<string> {
  const created = await createTicket(tenant, {
    customer,
    state: spec.state,
    group: spec.group ?? null,
    owner: spec.owner ?? null,
    now: spec.createdAt ?? NOW,
    messages: [{ body: 'Hello' }],
  });
  await unitOfWork(tenant, async (tx, repo) => {
    await repo.patch(tx, created.id, spec);
    if (spec.sla !== undefined) await repo.insertSla(tx, created.id, spec.sla);
  });
  return created.id;
}

async function dashboard(user: TestUser): Promise<DashboardBody> {
  const response = await asUser(user).get('/dashboard');
  expect(response.status).toBe(200);
  return response.body as DashboardBody;
}

async function setClock(date: Date): Promise<void> {
  (await getTestApp()).clock.set(date);
}

beforeEach(async () => {
  await setClock(NOW);
});

describe('GET /dashboard', () => {
  it('counts every figure exactly over tickets across states, priorities, owners and waiting_on', async () => {
    const tenant = await createTenant({ timezone: 'UTC' });
    const admin = await createUser(tenant, { roles: ['admin'] });
    const agent = await createUser(tenant, { roles: ['agent'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const group = await createGroup(tenant);
    const createdAt = new Date(NOW.getTime() - 3 * HOUR);
    const g = group.id;

    await ticket(tenant, customer, { state: 'new', group: g, createdAt, firstReplyAt: new Date(createdAt.getTime() + 10 * MINUTE) });
    await ticket(tenant, customer, {
      state: 'open', group: g, owner: agent.id, priority: 'urgent', createdAt,
      firstReplyAt: new Date(createdAt.getTime() + 5 * MINUTE),
    });
    await ticket(tenant, customer, { state: 'pending_reminder', group: g, owner: agent.id, priority: 'urgent', waitingOn: 'customer', createdAt });
    await ticket(tenant, customer, { state: 'pending_close', waitingOn: 'customer', createdAt });
    await ticket(tenant, customer, {
      state: 'resolved', group: g, owner: agent.id, priority: 'urgent', waitingOn: 'customer', createdAt,
      resolvedAt: new Date(createdAt.getTime() + 60 * MINUTE),
    });
    await ticket(tenant, customer, {
      state: 'closed', group: g, priority: 'urgent', createdAt, sla: 'breached',
      resolvedAt: new Date(createdAt.getTime() + 120 * MINUTE),
    });
    await ticket(tenant, customer, { state: 'open', owner: agent.id, createdAt, sla: 'breached' });
    await ticket(tenant, customer, {
      state: 'resolved', group: g, createdAt, sla: 'breached', resolvedAt: new Date(createdAt.getTime() + 30 * MINUTE),
    });
    await ticket(tenant, customer, { state: 'open', group: g, owner: agent.id, createdAt, sla: 'warning' });

    const body = await dashboard(admin);
    expect(body).toEqual({
      counts: {
        open: 6, // new, open, pending_reminder, pending_close, ungrouped open, warning open
        ungrouped: 2, // pending_close and the ungrouped open ticket
        unassigned: 2, // new and pending_close
        waitingOnCustomer: 2,
        waitingOnSupport: 4, // new, open urgent, ungrouped open, warning open
        urgent: 2, // resolved and closed urgent tickets do not count
        slaBreached: 2, // the closed breached ticket does not count; the resolved one does
      },
      today: { created: 9, resolved: 3 },
      averages: { firstResponseMinutes: 7.5, resolutionMinutes: 70, window: 'P7D' },
      satisfaction: { average: null, responses: 0 },
    });
  });

  it('returns zeros and null averages when the tenant has no tickets', async () => {
    const tenant = await createTenant({ timezone: 'UTC' });
    const admin = await createUser(tenant, { roles: ['admin'] });
    expect(await dashboard(admin)).toEqual(EMPTY);
  });

  it('rounds averages to two decimals', async () => {
    const tenant = await createTenant({ timezone: 'UTC' });
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const createdAt = new Date(NOW.getTime() - HOUR);
    await ticket(tenant, customer, {
      state: 'resolved', createdAt,
      firstReplyAt: new Date(createdAt.getTime() + 100_000), // 1.6667 min
      resolvedAt: new Date(createdAt.getTime() + 200_000), // 3.3333 min
    });
    const body = await dashboard(admin);
    expect(body.averages).toEqual({ firstResponseMinutes: 1.67, resolutionMinutes: 3.33, window: 'P7D' });
  });

  it('averages only the last 7 days (boundary inclusive)', async () => {
    const tenant = await createTenant({ timezone: 'UTC' });
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const since = new Date(NOW.getTime() - 7 * DAY);

    // Created just before the window: its first response is excluded.
    const justBefore = new Date(since.getTime() - 1000);
    await ticket(tenant, customer, { state: 'open', createdAt: justBefore, firstReplyAt: new Date(justBefore.getTime() + 50 * MINUTE) });
    // Created exactly at the boundary: included; resolved 60 min later.
    await ticket(tenant, customer, {
      state: 'resolved', createdAt: since,
      firstReplyAt: new Date(since.getTime() + 10 * MINUTE), resolvedAt: new Date(since.getTime() + 60 * MINUTE),
    });
    // Created 8 days ago and resolved 8 days ago: excluded from both.
    const eightDays = new Date(NOW.getTime() - 8 * DAY);
    await ticket(tenant, customer, {
      state: 'resolved', createdAt: eightDays,
      firstReplyAt: new Date(eightDays.getTime() + 500 * MINUTE), resolvedAt: new Date(eightDays.getTime() + HOUR),
    });
    // Created 8 days ago, resolved exactly at the boundary: resolution (1 day) included.
    await ticket(tenant, customer, { state: 'resolved', createdAt: eightDays, resolvedAt: since });

    const body = await dashboard(admin);
    expect(body.averages.firstResponseMinutes).toBe(10);
    expect(body.averages.resolutionMinutes).toBe(750); // (60 + 1440) / 2
    expect(body.today).toEqual({ created: 0, resolved: 0 });
  });

  it('counts today from local midnight in the tenant timezone, not UTC midnight', async () => {
    const tenant = await createTenant({ timezone: 'America/Los_Angeles' }); // PDT, UTC-7 on these dates
    await setClock(new Date('2026-03-11T05:00:00.000Z')); // 22:00 local on 2026-03-10
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    // Local midnight of the 10th is 07:00Z.
    await ticket(tenant, customer, { state: 'open', createdAt: new Date('2026-03-10T06:59:59.000Z') });
    await ticket(tenant, customer, { state: 'open', createdAt: new Date('2026-03-10T07:00:00.000Z') });
    await ticket(tenant, customer, {
      state: 'resolved', createdAt: new Date('2026-03-10T08:00:00.000Z'), resolvedAt: new Date('2026-03-10T09:00:00.000Z'),
    });
    await ticket(tenant, customer, {
      state: 'resolved', createdAt: new Date('2026-03-09T20:00:00.000Z'), resolvedAt: new Date('2026-03-10T06:00:00.000Z'),
    });

    // Two created and one resolved are "today" in Los Angeles although UTC midnight has not passed.
    expect((await dashboard(admin)).today).toEqual({ created: 2, resolved: 1 });

    // Crossing local midnight (07:00Z on the 11th) resets today.
    await setClock(new Date('2026-03-11T06:59:59.000Z'));
    expect((await dashboard(admin)).today).toEqual({ created: 2, resolved: 1 });
    await setClock(new Date('2026-03-11T07:00:00.000Z'));
    expect((await dashboard(admin)).today).toEqual({ created: 0, resolved: 0 });
  });

  it('counts slaBreached only for breached, not-closed tickets', async () => {
    const tenant = await createTenant({ timezone: 'UTC' });
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    await ticket(tenant, customer, { state: 'open', sla: 'breached' });
    await ticket(tenant, customer, { state: 'pending_close', sla: 'breached' });
    await ticket(tenant, customer, { state: 'resolved', sla: 'breached', resolvedAt: NOW });
    await ticket(tenant, customer, { state: 'closed', sla: 'breached', resolvedAt: NOW });
    await ticket(tenant, customer, { state: 'open', sla: 'warning' });
    await ticket(tenant, customer, { state: 'open', sla: 'ok' });
    await ticket(tenant, customer, { state: 'open' });
    expect((await dashboard(admin)).counts.slaBreached).toBe(3);
  });

  it('reports the satisfaction placeholder until ratings exist', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    expect((await dashboard(admin)).satisfaction).toEqual({ average: null, responses: 0 });
  });

  describe('access', () => {
    it('answers 403 PERMISSION_DENIED without dashboard.view', async () => {
      const tenant = await createTenant();
      const role = await createRole(tenant, { permissions: ['ticket.view'] });
      const user = await createUser(tenant, { roles: [{ id: role.id }] });
      const response = await asUser(user).get('/dashboard');
      expect(response.status).toBe(403);
      expect((response.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
    });

    it('answers 401 without a session', async () => {
      const tenant = await createTenant();
      const response = await asGuest(tenant).get('/dashboard');
      expect(response.status).toBe(401);
    });

    it('answers 404 to a customer session', async () => {
      const tenant = await createTenant();
      const customer = await createUser(tenant, { roles: ['customer'] });
      const response = await asUser(customer).get('/dashboard');
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('counts only tickets in groups the viewer may view, and ungrouped ones only with Ungrouped access', async () => {
      const tenant = await createTenant({ timezone: 'UTC' });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const visible = await createGroup(tenant);
      const hidden = await createGroup(tenant);
      const role = await createRole(tenant, {
        permissions: ['dashboard.view', 'ticket.view'],
        groups: [{ group: visible.id, flags: { view: true } }],
      });
      const viewer = await createUser(tenant, { roles: [{ id: role.id }] });
      const admin = await createUser(tenant, { roles: ['admin'] });
      const createdAt = new Date(NOW.getTime() - 2 * HOUR);

      await ticket(tenant, customer, { state: 'open', group: visible.id, priority: 'urgent', sla: 'breached', createdAt });
      // Hidden group and ungrouped tickets with every figure set: none may leak into any number.
      await ticket(tenant, customer, {
        state: 'resolved', group: hidden.id, priority: 'urgent', sla: 'breached', createdAt,
        firstReplyAt: new Date(createdAt.getTime() + MINUTE), resolvedAt: new Date(createdAt.getTime() + HOUR),
      });
      await ticket(tenant, customer, { state: 'open', group: hidden.id, priority: 'urgent', waitingOn: 'customer', sla: 'breached', createdAt });
      await ticket(tenant, customer, {
        state: 'resolved', priority: 'urgent', sla: 'breached', createdAt,
        firstReplyAt: new Date(createdAt.getTime() + MINUTE), resolvedAt: new Date(createdAt.getTime() + HOUR),
      });
      await ticket(tenant, customer, { state: 'open', priority: 'urgent', waitingOn: 'customer', createdAt });

      expect(await dashboard(viewer)).toEqual({
        ...EMPTY,
        counts: { ...EMPTY.counts, open: 1, unassigned: 1, waitingOnSupport: 1, urgent: 1, slaBreached: 1 },
        today: { created: 1, resolved: 0 },
      });

      // Admin sees all five.
      expect((await dashboard(admin)).today.created).toBe(5);

      // Granting Ungrouped view adds the two ungrouped tickets (one resolved, one open).
      await setGroupAccess(tenant, { id: role.id }, null, { view: true });
      expect(await dashboard(viewer)).toEqual({
        counts: { open: 2, ungrouped: 1, unassigned: 2, waitingOnSupport: 1, waitingOnCustomer: 1, urgent: 2, slaBreached: 2 },
        today: { created: 3, resolved: 1 },
        averages: { firstResponseMinutes: 1, resolutionMinutes: 60, window: 'P7D' },
        satisfaction: { average: null, responses: 0 },
      });
    });
  });

  describe('tenant isolation', () => {
    it('never counts another tenant tickets and leaks none of its data', async () => {
      const a = await createTenant({ timezone: 'UTC' });
      const b = await createTenant({ timezone: 'UTC' });
      const adminA = await createUser(a, { roles: ['admin'] });
      const adminB = await createUser(b, { roles: ['admin'] });
      const customerA = await createUser(a, { roles: ['customer'] });
      const customerB = await createUser(b, { roles: ['customer'] });
      const groupA = await createGroup(a);
      const createdAt = new Date(NOW.getTime() - HOUR);
      const idA = await ticket(a, customerA, {
        state: 'open', group: groupA.id, priority: 'urgent', sla: 'breached', createdAt,
        firstReplyAt: new Date(createdAt.getTime() + MINUTE),
      });

      const bodyB = await asUser(adminB).get('/dashboard');
      expect(bodyB.status).toBe(200);
      expect(bodyB.body).toEqual(EMPTY);
      const serialized = JSON.stringify(bodyB.body);
      for (const id of [idA, groupA.id, a.id, customerA.id]) expect(serialized).not.toContain(id);

      // B's own ticket does not change A's numbers.
      await ticket(b, customerB, { state: 'open', priority: 'urgent', createdAt });
      const bodyA = await dashboard(adminA);
      expect(bodyA.counts).toEqual({ ...EMPTY.counts, open: 1, waitingOnSupport: 1, unassigned: 1, urgent: 1, slaBreached: 1 });
      expect(bodyA.today.created).toBe(1);
    });
  });
});
