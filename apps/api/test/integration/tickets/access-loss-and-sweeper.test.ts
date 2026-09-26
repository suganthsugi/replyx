import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/platform-kernel/db/database.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import {
  createGroup,
  createRole,
  createTenant,
  createTicket,
  createUser,
  type TestTenant,
} from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { countEventsOfType, runAccessLoss, sweeperJob } from '../../support/jobs.js';

/**
 * T149: owners losing access unassign their tickets (FR-026, access-loss.consumer.ts), and the
 * timer sweeper (sweeper.job.ts, FR-034/FR-035) fires reminders once and closes pending/expired
 * tickets, racing correctly with a customer message (customer-message-router.ts).
 */

interface TicketRowSnapshot {
  ownerId: string | null;
  state: string;
  pendingUntil: Date | null;
  closedAt: Date | null;
  reminderNotifiedAt: Date | null;
}

interface HistoryRowSnapshot {
  field: string;
  actorKind: string;
  newValue: unknown;
}

class TicketSnapshotRepository extends TenantRepository {
  ticket(tx: TenantTransaction, id: string) {
    return this.selectFrom(tx, 'tickets')
      .select(['tickets.owner_id', 'tickets.state', 'tickets.pending_until', 'tickets.closed_at', 'tickets.reminder_notified_at'])
      .where('tickets.id', '=', id)
      .executeTakeFirstOrThrow();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history')
      .select(['ticket_history.field', 'ticket_history.actor_kind', 'ticket_history.new_value', 'ticket_history.created_at'])
      .where('ticket_history.ticket_id', '=', ticketId)
      .orderBy('ticket_history.created_at', 'asc')
      .execute();
  }

  messagesByClientId(tx: TenantTransaction, clientMessageId: string) {
    return this.selectFrom(tx, 'ticket_messages').select(['ticket_messages.ticket_id']).where('ticket_messages.client_message_id', '=', clientMessageId).execute();
  }
}

async function inTenant<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: TicketSnapshotRepository) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-snapshot' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new TicketSnapshotRepository(ctx)));
}

async function ticketRow(tenant: TestTenant, id: string): Promise<TicketRowSnapshot> {
  const row = await inTenant(tenant, (tx, repo) => repo.ticket(tx, id));
  return { ownerId: row.owner_id, state: row.state, pendingUntil: row.pending_until, closedAt: row.closed_at, reminderNotifiedAt: row.reminder_notified_at };
}

async function historyRows(tenant: TestTenant, ticketId: string): Promise<HistoryRowSnapshot[]> {
  const rows = await inTenant(tenant, (tx, repo) => repo.history(tx, ticketId));
  return rows.map((row) => ({ field: row.field, actorKind: row.actor_kind, newValue: row.new_value }));
}

async function ticketsForClientMessageId(tenant: TestTenant, clientMessageId: string): Promise<string[]> {
  const rows = await inTenant(tenant, (tx, repo) => repo.messagesByClientId(tx, clientMessageId));
  return rows.map((row) => row.ticket_id);
}

interface RoleBody {
  name: string;
  description?: string;
  permissions: string[];
  groupAccess: { groupId: string | null; view: boolean; create: boolean; edit: boolean; delete: boolean }[];
}

/** Flips `edit` for one group on a role, the way the role editor would, and returns the response. */
async function revokeGroupEdit(tenant: TestTenant, admin: Awaited<ReturnType<typeof createUser>>, roleId: string, groupId: string) {
  const current = await asUser(admin).get(`/roles/${roleId}`);
  expect(current.status).toBe(200);
  const body = current.body as RoleBody;
  const groupAccess = body.groupAccess.map((entry) => (entry.groupId === groupId ? { ...entry, edit: false } : entry));
  return asUser(admin).put(`/roles/${roleId}`, {
    name: body.name,
    ...(body.description === undefined ? {} : { description: body.description }),
    permissions: body.permissions,
    groupAccess,
  });
}

describe('ticket access loss and the timer sweeper', () => {
  let tenant: TestTenant;

  beforeEach(async () => {
    await getTestApp();
    tenant = await createTenant();
  });

  describe('access loss', () => {
    it('unassigns the owner when their role loses edit on the ticket group (role.updated)', async () => {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const group = await createGroup(tenant);
      const role = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: true } }] });
      const owner = await createUser(tenant, { roles: [{ id: role.id }] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open' });

      const updated = await revokeGroupEdit(tenant, admin, role.id, group.id);
      expect(updated.status).toBe(200);

      await runAccessLoss(tenant.id, 'role.updated');

      const row = await ticketRow(tenant, ticket.id);
      expect(row.ownerId).toBeNull();
      const history = await historyRows(tenant, ticket.id);
      expect(history).toContainEqual(expect.objectContaining({ field: 'owner_id', actorKind: 'system', newValue: null }));
    });

    it('unassigns the owner on a broader access.changed reason (a role change without edit)', async () => {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const group = await createGroup(tenant);
      const editingRole = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: true } }] });
      const viewOnlyRole = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: false } }] });
      const owner = await createUser(tenant, { roles: [{ id: editingRole.id }] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open' });

      const patched = await asUser(admin).patch(`/users/${owner.id}`, { roleIds: [viewOnlyRole.id] });
      expect(patched.status).toBe(200);

      await runAccessLoss(tenant.id, 'access.changed');

      const row = await ticketRow(tenant, ticket.id);
      expect(row.ownerId).toBeNull();
      const history = await historyRows(tenant, ticket.id);
      expect(history).toContainEqual(expect.objectContaining({ field: 'owner_id', actorKind: 'system', newValue: null }));
    });

    it('leaves the owner in place when another role still grants edit', async () => {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const group = await createGroup(tenant);
      const roleA = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: true } }] });
      const roleB = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: true } }] });
      const owner = await createUser(tenant, { roles: [{ id: roleA.id }, { id: roleB.id }] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open' });

      const updated = await revokeGroupEdit(tenant, admin, roleA.id, group.id);
      expect(updated.status).toBe(200);

      await runAccessLoss(tenant.id, 'role.updated');

      const row = await ticketRow(tenant, ticket.id);
      expect(row.ownerId).toBe(owner.id);
      const history = await historyRows(tenant, ticket.id);
      expect(history.some((entry) => entry.field === 'owner_id')).toBe(false);
    });

    it('unassigns every ticket owned by a deactivated agent, grouped and ungrouped', async () => {
      const admin = await createUser(tenant, { roles: ['admin'] });
      const group = await createGroup(tenant);
      const role = await createRole(tenant, { groups: [{ group: group.id, flags: { view: true, edit: true } }, { group: null, flags: { view: true, edit: true } }] });
      const owner = await createUser(tenant, { roles: [{ id: role.id }] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const grouped = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'open' });
      const ungrouped = await createTicket(tenant, { customer, group: null, owner: owner.id, state: 'open' });

      const deactivated = await asUser(admin).post(`/users/${owner.id}/deactivate`, {});
      expect(deactivated.status).toBe(200);

      await runAccessLoss(tenant.id, 'user.deactivated');

      for (const ticket of [grouped, ungrouped]) {
        const row = await ticketRow(tenant, ticket.id);
        expect(row.ownerId).toBeNull();
        const history = await historyRows(tenant, ticket.id);
        expect(history).toContainEqual(expect.objectContaining({ field: 'owner_id', actorKind: 'system', newValue: null }));
      }
    });
  });

  describe('timer sweeper', () => {
    it('reaches a pending reminder once per pending_until, and re-arms on a later date', async () => {
      const group = await createGroup(tenant);
      const owner = await createUser(tenant, { roles: ['admin'] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const { clock } = await getTestApp();
      const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'pending_reminder' });

      const before = await countEventsOfType(tenant.id, 'ticket.reminder_reached');
      clock.advanceHours(73); // past the factory's 72 h pending_until
      const job = await sweeperJob();
      await job.process();

      const afterFirst = await countEventsOfType(tenant.id, 'ticket.reminder_reached');
      expect(afterFirst).toBe(before + 1);
      const row = await ticketRow(tenant, ticket.id);
      expect(row.state).toBe('pending_reminder');
      expect(row.reminderNotifiedAt).not.toBeNull();

      // A second sweep at the same due date fires nothing more.
      await job.process();
      expect(await countEventsOfType(tenant.id, 'ticket.reminder_reached')).toBe(afterFirst);

      // Setting a later pending_until re-arms it. A fresh session: the clock has moved far past
      // the idle window of any session signed in before the sweep.
      const freshAdmin = await createUser(tenant, { roles: ['admin'] });
      const laterDate = new Date(clock.now().getTime() + 5 * 3_600_000).toISOString();
      const patched = await asUser(freshAdmin).patch(`/tickets/${ticket.id}`, { state: 'pending_reminder', pendingUntil: laterDate });
      expect(patched.status).toBe(200);
      clock.advanceHours(6);
      await job.process();
      expect(await countEventsOfType(tenant.id, 'ticket.reminder_reached')).toBe(afterFirst + 1);
    });

    it('closes a due pending_close ticket', async () => {
      const group = await createGroup(tenant);
      const owner = await createUser(tenant, { roles: ['admin'] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const { clock } = await getTestApp();
      const ticket = await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'pending_close' });

      clock.advanceHours(73);
      const job = await sweeperJob();
      await job.process();

      const row = await ticketRow(tenant, ticket.id);
      expect(row.state).toBe('closed');
      expect(row.closedAt).not.toBeNull();
      const history = await historyRows(tenant, ticket.id);
      expect(history).toContainEqual(expect.objectContaining({ field: 'state', actorKind: 'system', newValue: 'closed' }));
    });

    it('lands a customer message racing an auto-close on exactly one ticket', async () => {
      const group = await createGroup(tenant);
      const owner = await createUser(tenant, { roles: ['admin'] });
      const customer = await createUser(tenant, { roles: ['customer'] });
      const { clock } = await getTestApp();
      await createTicket(tenant, { customer, group: group.id, owner: owner.id, state: 'pending_close' });

      clock.advanceHours(73);
      const job = await sweeperJob();
      const clientMessageId = uuidv7();

      const [, sent] = await Promise.all([
        job.process(),
        asUser(customer).post('/customer/messages', { body: 'Still there?', clientMessageId }),
      ]);
      expect(sent.status).toBe(201);

      const ticketIds = await ticketsForClientMessageId(tenant, clientMessageId);
      expect(ticketIds).toHaveLength(1);
    });

    it('sweeps every active tenant once each and leaves a suspended tenant untouched', async () => {
      const { clock } = await getTestApp();
      const [tenantA, tenantB, suspendedTenant] = await Promise.all([createTenant(), createTenant(), createTenant()]);

      async function seed(t: TestTenant) {
        const group = await createGroup(t);
        const owner = await createUser(t, { roles: ['admin'] });
        const customer = await createUser(t, { roles: ['customer'] });
        const reminderTicket = await createTicket(t, { customer, group: group.id, owner: owner.id, state: 'pending_reminder' });
        const closeTicket = await createTicket(t, { customer, group: group.id, owner: owner.id, state: 'pending_close' });
        return { reminderTicket, closeTicket };
      }

      const [seededA, seededB, seededSuspended] = await Promise.all([seed(tenantA), seed(tenantB), seed(suspendedTenant)]);

      // Sign in fresh happens above (all before the big clock jump); suspend the third tenant
      // through the platform connection, the way kernel.test.ts does, then run one sweep.
      const platform = createDatabase(process.env.DATABASE_URL_PLATFORM as string, 'platform');
      try {
        await sql`UPDATE tenants SET status = 'suspended', suspended_at = now() WHERE id = ${suspendedTenant.id}`.execute(platform);
      } finally {
        await platform.destroy();
      }

      clock.advanceHours(73); // past every factory's 72 h pending_until
      const job = await sweeperJob();
      await job.process();

      for (const [activeTenant, seeded] of [
        [tenantA, seededA],
        [tenantB, seededB],
      ] as const) {
        const reminderRow = await ticketRow(activeTenant, seeded.reminderTicket.id);
        expect(reminderRow.state).toBe('pending_reminder');
        expect(reminderRow.reminderNotifiedAt).not.toBeNull();
        expect(await countEventsOfType(activeTenant.id, 'ticket.reminder_reached')).toBe(1);
        expect(await historyRows(activeTenant, seeded.reminderTicket.id)).toHaveLength(0);

        const closeRow = await ticketRow(activeTenant, seeded.closeTicket.id);
        expect(closeRow.state).toBe('closed');
        expect(closeRow.closedAt).not.toBeNull();
        expect(await countEventsOfType(activeTenant.id, 'ticket.closed')).toBe(1);
        const closeHistory = await historyRows(activeTenant, seeded.closeTicket.id);
        expect(closeHistory).toContainEqual(expect.objectContaining({ field: 'state', actorKind: 'system', newValue: 'closed' }));
      }

      // The suspended tenant's due tickets are left exactly as they were.
      const suspendedReminderRow = await ticketRow(suspendedTenant, seededSuspended.reminderTicket.id);
      expect(suspendedReminderRow.state).toBe('pending_reminder');
      expect(suspendedReminderRow.reminderNotifiedAt).toBeNull();
      expect(await countEventsOfType(suspendedTenant.id, 'ticket.reminder_reached')).toBe(0);

      const suspendedCloseRow = await ticketRow(suspendedTenant, seededSuspended.closeTicket.id);
      expect(suspendedCloseRow.state).toBe('pending_close');
      expect(suspendedCloseRow.closedAt).toBeNull();
      expect(await countEventsOfType(suspendedTenant.id, 'ticket.closed')).toBe(0);
    });
  });
});
