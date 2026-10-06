import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestApp, getTestWorker } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { sweeperJob } from '../../support/jobs.js';
import { createBusinessHours, createSlaPolicy, recomputeSla } from '../../support/sla.js';

/**
 * SLA notifications (T226, T223 notifications.consumer.ts / recipient-resolver.ts): `sla.warning`
 * and `sla.breached` become in-app notifications for the ticket's owner, or the group's viewers when
 * it has none. Runs the real worker (relay and consumers); the sweeper runs by hand on the API
 * app's TestClock. Tickets are fixture rows, so no other event feeds the notification consumer.
 */

const T0 = new Date('2026-03-09T10:00:00.000Z');
const MINUTE = 60_000;

interface NotificationDto {
  eventType: string;
  title: string;
  ticketId: string | null;
  read: boolean;
}

async function notificationsOf(user: TestUser): Promise<NotificationDto[]> {
  const response = await asUser(user).get('/notifications');
  expect(response.status).toBe(200);
  return (response.body as { items: NotificationDto[] }).items;
}

async function waitForNotification(user: TestUser, eventType: string, ticketId: string): Promise<NotificationDto> {
  let found: NotificationDto | undefined;
  await vi.waitFor(
    async () => {
      found = (await notificationsOf(user)).find((n) => n.eventType === eventType && n.ticketId === ticketId);
      if (found === undefined) throw new Error(`no ${eventType} notification yet`);
    },
    { timeout: 20_000, interval: 250 },
  );
  return found as NotificationDto;
}

async function advanceTo(minutes: number): Promise<void> {
  (await getTestApp()).clock.set(new Date(T0.getTime() + minutes * MINUTE));
  await (await sweeperJob()).process();
}

let tenant: TestTenant;

beforeAll(async () => {
  await getTestApp();
  await getTestWorker();
  tenant = await createTenant({ timezone: 'UTC' });
});

beforeEach(async () => {
  (await getTestApp()).clock.set(T0);
});

describe('sla notifications', () => {
  it('notifies the owner of a warning and then a breach, once each, and nobody else', async () => {
    const owner = await createUser(tenant, { roles: ['admin'] });
    const bystander = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, { businessHours: hours, firstResponseMinutes: 60, warningPercent: 80 });
    const ticket = await createTicket(tenant, { customer, owner: owner.id, state: 'open', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    await advanceTo(50);
    const warning = await waitForNotification(owner, 'sla.warning', ticket.id);
    expect(warning.title).toContain(`#${ticket.number}`);
    expect(warning.title).toContain('first response');
    expect(warning.read).toBe(false);

    await advanceTo(61);
    await advanceTo(62);
    const breach = await waitForNotification(owner, 'sla.breached', ticket.id);
    expect(breach.title).toContain('breached');

    const mine = (await notificationsOf(owner)).filter((n) => n.ticketId === ticket.id && n.eventType.startsWith('sla.'));
    expect(mine.map((n) => n.eventType).sort()).toEqual(['sla.breached', 'sla.warning']);
    // A viewer who is not the owner gets nothing while an owner exists.
    expect((await notificationsOf(bystander)).filter((n) => n.ticketId === ticket.id)).toEqual([]);
  });

  it('notifies the group viewers (and only them) when the ticket has no owner', async () => {
    const group = await createGroup(tenant);
    const otherGroup = await createGroup(tenant);
    const viewerRole = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: group.id, flags: { view: true } }] });
    const outsiderRole = await createRole(tenant, { permissions: ['ticket.view'], groups: [{ group: otherGroup.id, flags: { view: true } }] });
    const viewer = await createUser(tenant, { roles: [{ id: viewerRole.id }] });
    const outsider = await createUser(tenant, { roles: [{ id: outsiderRole.id }] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const hours = await createBusinessHours(tenant);
    await createSlaPolicy(tenant, {
      businessHours: hours,
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group.id }] },
      firstResponseMinutes: 30,
    });
    const ticket = await createTicket(tenant, { customer, group: group.id, state: 'new', now: T0, messages: [{ body: 'Help' }] });
    await recomputeSla(tenant, ticket.id);

    await advanceTo(40); // past the 30 minute due time
    const breach = await waitForNotification(viewer, 'sla.breached', ticket.id);
    expect(breach.title).toContain('first response');
    expect((await notificationsOf(outsider)).filter((n) => n.ticketId === ticket.id)).toEqual([]);
  });
});
