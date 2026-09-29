import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, getTestWorker, service } from '../../support/app.js';
import {
  createGroup,
  createRole,
  createTenant,
  createTicket,
  createUser,
  type TestTenant,
} from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { connectSocket, waitForEvent } from '../../support/socket.js';

import type { Socket } from 'socket.io-client';
import type { Test } from 'supertest';

/**
 * `POST /tickets/{id}/triage` (T176; contracts/tickets.yaml `triageTicket`, triage.service.ts,
 * tickets.service.ts `applyLocked`). Every case from the spec: success, 403/404 by permission,
 * cross-tenant 404, concurrent triage (409 ALREADY_TRIAGED), destination validation (409/404/400),
 * `visibleToCaller` with the ticket.removed_from_view socket event, the arrived_in_group
 * notification (actor excluded), and SC-003 (a fresh ungrouped ticket reaches a Needs Triage
 * viewer's socket within 2 s).
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';
const SC_003_MS = 2_000;

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

interface RefBody {
  id: string;
  name: string;
}
interface TicketBody {
  id: string;
  group: RefBody | null;
  owner: RefBody | null;
  priority: string;
  tags: RefBody[];
}
interface TriageResponseBody {
  visibleToCaller: boolean;
  ticket?: TicketBody;
}
interface Envelope {
  id: string;
  type: string;
  stream: string;
  data: Record<string, unknown>;
}
interface NotificationListBody {
  items: { id: string; eventType: string; ticketId: string | null }[];
}

const body = <T>(response: { body: unknown }) => response.body as T;
const failure = (response: { body: unknown }) => response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

class Inspect extends TenantRepository {
  ticket(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select(['group_id', 'owner_id', 'priority']).where('id', '=', ticketId).executeTakeFirst();
  }

  history(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'ticket_history')
      .select(['field', 'old_value', 'new_value'])
      .where('ticket_id', '=', ticketId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'triage-test' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

/** A role with `ticket.view`/`ticket.edit` and the given Ungrouped/group flags. */
async function roleWithUngrouped(
  tenant: TestTenant,
  ungroupedFlags: { view: boolean; edit: boolean },
  groups: { group: string; flags: { view?: boolean; edit?: boolean } }[] = [],
): Promise<{ id: string }> {
  return createRole(tenant, {
    permissions: ['ticket.view', 'ticket.edit'],
    groups: [{ group: null, flags: ungroupedFlags }, ...groups.map((g) => ({ group: g.group, flags: g.flags }))],
  });
}

const envelope = (socket: Socket, match: (e: Envelope) => boolean, timeoutMs = 5_000) => waitForEvent<Envelope>(socket, 'event', match, timeoutMs);

beforeAll(async () => {
  await getTestApp();
});

describe('POST /tickets/{id}/triage', () => {
  it('triages an ungrouped ticket to a group with owner, priority and tags, with one history row per changed field (success)', async () => {
    const tenant = await createTenant();
    const destination = await createGroup(tenant);
    const admin = await createUser(tenant, { roles: ['admin'] });
    const owner = await createUser(tenant, { roles: [{ id: (await roleWithUngrouped(tenant, { view: true, edit: false }, [{ group: destination.id, flags: { view: true, edit: true } }])).id }] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const tag = await asUser(admin).post('/tags', { name: 'VIP' });

    const response = await asUser(admin).post(`/tickets/${ticket.id}/triage`, {
      groupId: destination.id,
      ownerId: owner.id,
      priority: 'high',
      tagIds: [(tag.body as { id: string }).id],
    });
    expect(response.status).toBe(200);
    const result = body<TriageResponseBody>(response);
    expect(result.visibleToCaller).toBe(true);
    expect(result.ticket).toMatchObject({ group: { id: destination.id }, owner: { id: owner.id }, priority: 'high' });
    expect(result.ticket?.tags.map((t) => t.name)).toEqual(['VIP']);

    const row = await inspect(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    expect(row).toMatchObject({ group_id: destination.id, owner_id: owner.id, priority: 'high' });

    const history = await inspect(tenant, (tx, repo) => repo.history(tx, ticket.id));
    const fields = history.map((h) => h.field);
    expect(fields).toContain('group_id');
    expect(fields).toContain('owner_id');
    expect(fields).toContain('priority');
    // One row per changed field, no duplicates.
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('is 403 for a user who can view Ungrouped but not edit it, and 404 for a user without Ungrouped access at all', async () => {
    const tenant = await createTenant();
    const destination = await createGroup(tenant);
    const customer = await createUser(tenant, { roles: ['customer'] });

    const viewerRole = await roleWithUngrouped(tenant, { view: true, edit: false });
    const viewer = await createUser(tenant, { roles: [{ id: viewerRole.id }] });
    const ticketForViewer = await createTicket(tenant, { customer, group: null, state: 'open' });
    const denied = await asUser(viewer).post(`/tickets/${ticketForViewer.id}/triage`, { groupId: destination.id });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));

    // ticket.edit granted at the registry level (so the route guard passes) but no group row at
    // all for Ungrouped: the ticket itself is invisible to this caller.
    const strangerRole = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit'] });
    const stranger = await createUser(tenant, { roles: [{ id: strangerRole.id }] });
    const ticketForStranger = await createTicket(tenant, { customer, group: null, state: 'open' });
    const notFound = await asUser(stranger).post(`/tickets/${ticketForStranger.id}/triage`, { groupId: destination.id });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual(errorBody('TICKET_NOT_FOUND'));
  });

  it('is a 404 for another tenant\'s ticket (cross-tenant)', async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const destination = await createGroup(tenant);
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const otherAdmin = await createUser(other, { roles: ['admin'] });

    await expectCrossTenant404((id) => asUser(otherAdmin).post(`/tickets/${id}/triage`, { groupId: destination.id }), ticket.id);
  });

  it('two concurrent triages of the same ticket give exactly one 200 and one 409 ALREADY_TRIAGED, even when the winner\'s group is invisible to the loser', async () => {
    const tenant = await createTenant();
    const groupOne = await createGroup(tenant);
    const groupTwo = await createGroup(tenant);
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });

    // Each caller can edit Ungrouped and can see only their own target group, never the other's.
    const roleOne = await roleWithUngrouped(tenant, { view: true, edit: true }, [{ group: groupOne.id, flags: { view: true, edit: true } }]);
    const roleTwo = await roleWithUngrouped(tenant, { view: true, edit: true }, [{ group: groupTwo.id, flags: { view: true, edit: true } }]);
    const callerOne = await createUser(tenant, { roles: [{ id: roleOne.id }] });
    const callerTwo = await createUser(tenant, { roles: [{ id: roleTwo.id }] });

    const [r1, r2] = await Promise.all([
      asUser(callerOne).post(`/tickets/${ticket.id}/triage`, { groupId: groupOne.id }),
      asUser(callerTwo).post(`/tickets/${ticket.id}/triage`, { groupId: groupTwo.id }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const [winner, loser] = r1.status === 200 ? [r1, r2] : [r2, r1];
    expect(failure(loser).error.code).toBe('ALREADY_TRIAGED');

    const finalRow = await inspect(tenant, (tx, repo) => repo.ticket(tx, ticket.id));
    const winnerGroupId = body<TriageResponseBody>(winner).ticket?.group?.id;
    expect(finalRow?.group_id).toBe(winnerGroupId);
    // The loser's own target never won, whichever request actually committed first.
    expect([groupOne.id, groupTwo.id]).toContain(winnerGroupId);
  });

  it('refuses an inactive destination (409 GROUP_INACTIVE), an ineligible owner (409 OWNER_NOT_ELIGIBLE), an unknown group (404) and bad bodies (400)', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const inactive = await createGroup(tenant, { status: 'inactive' });
    const active = await createGroup(tenant);
    const outsider = await createUser(tenant, { roles: ['agent'] });

    const inactiveTicket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const inactiveResponse = await asUser(admin).post(`/tickets/${inactiveTicket.id}/triage`, { groupId: inactive.id });
    expect(inactiveResponse.status).toBe(409);
    expect(failure(inactiveResponse).error.code).toBe('GROUP_INACTIVE');

    const ownerTicket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const ownerResponse = await asUser(admin).post(`/tickets/${ownerTicket.id}/triage`, { groupId: active.id, ownerId: outsider.id });
    expect(ownerResponse.status).toBe(409);
    expect(failure(ownerResponse).error.code).toBe('OWNER_NOT_ELIGIBLE');

    const unknownGroupTicket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const unknownGroupResponse = await asUser(admin).post(`/tickets/${unknownGroupTicket.id}/triage`, { groupId: UNKNOWN_ID });
    expect(unknownGroupResponse.status).toBe(404);
    expect(unknownGroupResponse.body).toEqual(errorBody('GROUP_NOT_FOUND'));

    const badBodyTicket = await createTicket(tenant, { customer, group: null, state: 'open' });
    const missingGroupId = await asUser(admin).post(`/tickets/${badBodyTicket.id}/triage`, {});
    expect(missingGroupId.status).toBe(400);
    expect(failure(missingGroupId).error.details).toEqual([{ path: 'groupId', issue: 'required' }]);

    const unknownKey = await asUser(admin).post(`/tickets/${badBodyTicket.id}/triage`, { groupId: active.id, bogus: true });
    expect(unknownKey.status).toBe(400);
    expect(failure(unknownKey).error.details).toEqual([{ path: 'bogus', issue: 'unrecognized_key' }]);
  });

  it('answers visibleToCaller: false with no ticket when the caller cannot see the destination, and the Ungrouped stream gets ticket.removed_from_view (reason moved)', async () => {
    const tenant = await createTenant();
    const destination = await createGroup(tenant); // triager has no access here at all
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });

    const triagerRole = await roleWithUngrouped(tenant, { view: true, edit: true });
    const triager = await createUser(tenant, { roles: [{ id: triagerRole.id }] });

    await getTestWorker();
    const ungroupedViewerRole = await roleWithUngrouped(tenant, { view: true, edit: false });
    const ungroupedViewer = await createUser(tenant, { roles: [{ id: ungroupedViewerRole.id }] });
    const socket = await connectSocket(ungroupedViewer);
    try {
      const removed = envelope(socket, (e) => e.type === 'ticket.removed_from_view' && e.data.ticketId === ticket.id);
      const response = await asUser(triager).post(`/tickets/${ticket.id}/triage`, { groupId: destination.id });
      expect(response.status).toBe(200);
      const result = body<TriageResponseBody>(response);
      expect(result).toEqual({ visibleToCaller: false });

      const event = await removed;
      expect(event).toMatchObject({ stream: 'tickets', data: { ticketId: ticket.id, reason: 'moved' } });
    } finally {
      socket.close();
    }
  });

  it('notifies staff who can view the destination with ticket.arrived_in_group, excluding the triaging actor', async () => {
    const tenant = await createTenant();
    const destination = await createGroup(tenant, { access: [{ role: 'agent', flags: { view: true, edit: false } }] });
    const customer = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer, group: null, state: 'open' });

    // The triager can also view the destination, so it would be a candidate if actors weren't excluded.
    const triagerRole = await roleWithUngrouped(tenant, { view: true, edit: true }, [{ group: destination.id, flags: { view: true, edit: true } }]);
    const triager = await createUser(tenant, { roles: [{ id: triagerRole.id }] });
    const viewer = await createUser(tenant, { roles: ['agent'] }); // agent has view on `destination` above

    await getTestWorker();
    const socket = await connectSocket(viewer);
    try {
      const created = envelope(socket, (e) => e.type === 'notification.created' && e.data.ticketId === ticket.id);
      const response = await asUser(triager).post(`/tickets/${ticket.id}/triage`, { groupId: destination.id });
      expect(response.status).toBe(200);

      const event = await created;
      expect(event.data).toMatchObject({ eventType: 'ticket.arrived_in_group' });

      const viewerList = (await asUser(viewer).get('/notifications')).body as NotificationListBody;
      expect(viewerList.items.some((item) => item.eventType === 'ticket.arrived_in_group' && item.ticketId === ticket.id)).toBe(true);

      const triagerList = (await asUser(triager).get('/notifications')).body as NotificationListBody;
      expect(triagerList.items.some((item) => item.ticketId === ticket.id)).toBe(false);
    } finally {
      socket.close();
    }
  });

  it('SC-003: an ungrouped ticket from a customer message with no matching routing rule reaches a Needs Triage viewer within 2 s', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    // No routing rules configured: the message's ticket lands in Ungrouped.
    const viewerRole = await roleWithUngrouped(tenant, { view: true, edit: false });
    const viewer = await createUser(tenant, { roles: [{ id: viewerRole.id }] });

    await getTestWorker();
    const socket = await connectSocket(viewer);
    try {
      const created = envelope(socket, (e) => e.type === 'ticket.created');
      const started = Date.now();
      const sent = await asUser(customer).post('/customer/messages', { body: 'Anyone there?', clientMessageId: uuidv7() });
      expect(sent.status).toBe(201);

      const event = await created;
      expect(Date.now() - started).toBeLessThan(SC_003_MS);
      expect(event).toMatchObject({ stream: 'tickets' });
      const ticket = event.data.ticket as { group: unknown } | undefined;
      expect(ticket?.group).toBeNull();
    } finally {
      socket.close();
    }
  });
});

describe('a customer never triages (no such route for the customer audience)', () => {
  it('is 404, identical to an unknown customer route', async () => {
    const tenant = await createTenant();
    const customer = await createUser(tenant, { roles: ['customer'] });
    const other = await createUser(tenant, { roles: ['customer'] });
    const ticket = await createTicket(tenant, { customer: other, group: null, state: 'open' });
    const response = await asUser(customer).post(`/tickets/${ticket.id}/triage`, { groupId: UNKNOWN_ID });
    expect(response.status).toBe(404);
    expect(response.body).toEqual((await asUser(customer).get('/no-such-route')).body);
  });
});
