import { beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { DEFAULT_VIEWS } from '../../../src/views/default-views.contributor.js';
import { getTestApp } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';
import { createView } from '../../support/view-factory.js';

/**
 * `GET /views`, `GET /views/{id}` (T141) and `GET /tickets?viewId=` (T135): the 12 default views
 * seeded on provisioning (data-model.md "Default view conditions", FR-073), their visibility
 * (FR-076, FR-077) and the tickets each one returns (T148).
 */

interface ViewsResponseItem {
  id: string;
  name: string;
  system: string | null;
  conditions: unknown;
  hidden: boolean;
}

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

/** Typed `{ items }` body, matching the pattern in `test/integration/tags/tags.test.ts`. */
const items = <T>(response: { body: unknown }) => (response.body as { items: T[] }).items;

function byName(views: ViewsResponseItem[], name: string): ViewsResponseItem {
  const found = views.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No view named ${name} in ${JSON.stringify(views.map((i) => i.name))}`);
  return found;
}

let tenant: TestTenant;
let admin: TestUser;
let manager: TestUser; // has view.view + Ungrouped view access
let agentNoUngrouped: TestUser; // has view.view but no Ungrouped view access
let noPermissionUser: TestUser; // staff with no permissions at all

beforeAll(async () => {
  await getTestApp();
  tenant = await createTenant();
  admin = await createUser(tenant, { roles: ['admin'] });
  manager = await createUser(tenant, { roles: ['manager'] });
  agentNoUngrouped = await createUser(tenant, { roles: ['agent'] });
  const noPermissionRole = await createRole(tenant, { permissions: [] });
  noPermissionUser = await createUser(tenant, { roles: [{ id: noPermissionRole.id }] });
});

describe('a new tenant gets the 12 default views', () => {
  it('matches data-model.md "Default view conditions" exactly, in order', async () => {
    const response = await asUser(admin).get('/views');
    expect(response.status).toBe(200);
    const views = items<ViewsResponseItem>(response);
    expect(views).toHaveLength(12);
    expect(views.map((item) => item.system)).toEqual(DEFAULT_VIEWS.map((view) => view.systemKey));
    expect(views.map((item) => item.name)).toEqual(DEFAULT_VIEWS.map((view) => view.name));
    for (const [index, definition] of DEFAULT_VIEWS.entries()) {
      expect(views[index]!.conditions).toEqual(definition.conditions);
    }
    // All twelve are all_staff, editable, hideable, reorderable and unhidden by default.
    for (const item of items<{ visibility: string; editable: boolean; hidden: boolean }>(response)) {
      expect(item.visibility).toBe('all_staff');
      expect(item.editable).toBe(true);
      expect(item.hidden).toBe(false);
    }
  });
});

describe('each view returns the right tickets for a seeded ticket set', () => {
  let customer: TestUser;
  let groupA: { id: string };
  let tickets: Record<string, { id: string }>;

  beforeAll(async () => {
    customer = await createUser(tenant, { roles: ['customer'] });
    groupA = await createGroup(tenant, {
      access: [
        { role: 'agent', flags: { view: true, edit: true } },
        { role: 'manager', flags: { view: true, edit: true } },
      ],
    });

    const app = await getTestApp();
    const now = app.clock.now();
    // 100h in the past, so `now + 72h` (createTicket's pending_until for pending_reminder) lands
    // 28h *before* the real current clock, without advancing the shared test clock (that would
    // expire every session created so far in this file).
    const past = new Date(now.getTime() - 100 * 3_600_000);

    tickets = {
      // Needs Triage: ungrouped, not closed.
      needsTriage: await createTicket(tenant, { customer, group: null, state: 'new' }),
      // Excluded from Needs Triage: ungrouped but closed.
      needsTriageClosedExcluded: await createTicket(tenant, { customer, group: null, state: 'closed' }),

      // Unassigned & Open: grouped, unassigned, not closed.
      unassignedOpen: await createTicket(tenant, { customer, group: groupA.id, owner: null, state: 'open' }),
      // Excluded: has an owner.
      assignedExcluded: await createTicket(tenant, { customer, group: groupA.id, owner: admin.id, state: 'open' }),

      // My Tickets: owned by admin, not closed.
      myTicket: await createTicket(tenant, { customer, group: groupA.id, owner: admin.id, state: 'open' }),
      // Excluded: owned by someone else.
      othersTicketExcluded: await createTicket(tenant, { customer, group: groupA.id, owner: manager.id, state: 'open' }),

      // My Pending Reminders Reached: owned by admin, pending_reminder, pending_until in the past.
      myPendingReached: await createTicket(tenant, { customer, group: groupA.id, owner: admin.id, state: 'pending_reminder', now: past }),

      // Waiting on Support: waiting_on support, state new/open.
      waitingOnSupport: await createTicket(tenant, { customer, group: groupA.id, state: 'new' }),

      // All Open: state in new/open/pending_reminder/pending_close.
      allOpenNew: await createTicket(tenant, { customer, group: groupA.id, state: 'new' }),

      // New: state new (reuse allOpenNew).

      // Pending: pending_reminder or pending_close.
      pendingClose: await createTicket(tenant, { customer, group: groupA.id, state: 'pending_close' }),

      // High & Urgent: not closed.
      // (created via ticket update is out of scope here; state/priority set directly)
      resolvedTicket: await createTicket(tenant, { customer, group: groupA.id, state: 'resolved' }),
      closedTicket: await createTicket(tenant, { customer, group: groupA.id, state: 'closed' }),
    };
  });

  async function idsFor(viewSystemKey: string, user: TestUser): Promise<Set<string>> {
    const listed = await asUser(admin).get('/views');
    const view = items<ViewsResponseItem>(listed).find((item) => item.system === viewSystemKey);
    if (view === undefined) throw new Error(`No default view ${viewSystemKey}`);
    const response = await asUser(user).get(`/tickets?viewId=${view.id}&limit=100`);
    expect(response.status).toBe(200);
    return new Set(items<{ id: string }>(response).map((item) => item.id));
  }

  it('Needs Triage: ungrouped and not closed', async () => {
    const ids = await idsFor('needs_triage', admin);
    expect(ids.has(tickets.needsTriage!.id)).toBe(true);
    expect(ids.has(tickets.needsTriageClosedExcluded!.id)).toBe(false);
  });

  it('Unassigned & Open: grouped, unassigned, not closed', async () => {
    const ids = await idsFor('unassigned_open', admin);
    expect(ids.has(tickets.unassignedOpen!.id)).toBe(true);
    expect(ids.has(tickets.assignedExcluded!.id)).toBe(false);
    expect(ids.has(tickets.needsTriage!.id)).toBe(false); // ungrouped, excluded by "group is not ungrouped"
  });

  it('My Tickets: owned by the viewer, not closed (resolves per-viewer)', async () => {
    const idsForAdmin = await idsFor('my_tickets', admin);
    expect(idsForAdmin.has(tickets.myTicket!.id)).toBe(true);
    expect(idsForAdmin.has(tickets.othersTicketExcluded!.id)).toBe(false);

    const idsForManager = await idsFor('my_tickets', manager);
    expect(idsForManager.has(tickets.othersTicketExcluded!.id)).toBe(true);
    expect(idsForManager.has(tickets.myTicket!.id)).toBe(false);
  });

  it('My Pending Reminders Reached: owned by the viewer, pending_reminder, pending_until before now', async () => {
    const ids = await idsFor('my_pending_reminders_reached', admin);
    expect(ids.has(tickets.myPendingReached!.id)).toBe(true);
  });

  it('Waiting on Support: waiting_on support, state new/open', async () => {
    const ids = await idsFor('waiting_on_support', admin);
    expect(ids.has(tickets.waitingOnSupport!.id)).toBe(true);
    expect(ids.has(tickets.resolvedTicket!.id)).toBe(false);
  });

  it('All Open: state in new/open/pending_reminder/pending_close', async () => {
    const ids = await idsFor('all_open', admin);
    expect(ids.has(tickets.allOpenNew!.id)).toBe(true);
    expect(ids.has(tickets.pendingClose!.id)).toBe(true);
    expect(ids.has(tickets.resolvedTicket!.id)).toBe(false);
    expect(ids.has(tickets.closedTicket!.id)).toBe(false);
  });

  it('New: state is new', async () => {
    const ids = await idsFor('new', admin);
    expect(ids.has(tickets.allOpenNew!.id)).toBe(true);
    expect(ids.has(tickets.unassignedOpen!.id)).toBe(false);
  });

  it('Pending: pending_reminder or pending_close', async () => {
    const ids = await idsFor('pending', admin);
    expect(ids.has(tickets.pendingClose!.id)).toBe(true);
    expect(ids.has(tickets.myPendingReached!.id)).toBe(true);
    expect(ids.has(tickets.allOpenNew!.id)).toBe(false);
  });

  it('Escalated: matches nothing (sla_status not implemented until US12)', async () => {
    const ids = await idsFor('escalated', admin);
    expect(ids.size).toBe(0);
  });

  it('Resolved: state is resolved', async () => {
    const ids = await idsFor('resolved', admin);
    expect(ids.has(tickets.resolvedTicket!.id)).toBe(true);
    expect(ids.has(tickets.closedTicket!.id)).toBe(false);
  });

  it('Closed: state is closed', async () => {
    const ids = await idsFor('closed', admin);
    expect(ids.has(tickets.closedTicket!.id)).toBe(true);
    expect(ids.has(tickets.resolvedTicket!.id)).toBe(false);
  });
});

describe('Needs Triage is hidden without Ungrouped view access', () => {
  it('is absent from GET /views and 404 on GET /views/{id}', async () => {
    const visible = await asUser(admin).get('/views');
    const needsTriageId = byName(items<ViewsResponseItem>(visible), 'Needs Triage').id;

    const list = await asUser(agentNoUngrouped).get('/views');
    expect(list.status).toBe(200);
    const listItems = items<ViewsResponseItem>(list);
    expect(listItems.map((item) => item.name)).not.toContain('Needs Triage');
    expect(listItems).toHaveLength(11);

    const get = await asUser(agentNoUngrouped).get(`/views/${needsTriageId}`);
    const unknown = await asUser(agentNoUngrouped).get(`/views/${uuidv7()}`);
    expect(get.status).toBe(404);
    expect(get.body).toEqual(unknown.body);
    expect(get.body).toEqual(errorBody('VIEW_NOT_FOUND'));
  });
});

describe('GET /views returns only views shared with the viewer', () => {
  it('excludes personal views owned by someone else, and roles/groups views the viewer does not hold', async () => {
    const personalOwner = await createUser(tenant, { roles: ['agent'] });
    const otherAgent = await createUser(tenant, { roles: ['agent'] });
    const sharedRole = await createRole(tenant, { permissions: ['view.view', 'ticket.view'] });
    const sharedGroup = await createGroup(tenant);

    const personal = await createView(tenant, { name: 'Personal View', visibility: 'personal', ownerId: personalOwner.id });
    const rolesView = await createView(tenant, { name: 'Roles View', visibility: 'roles', sharedRoleIds: [sharedRole.id] });
    const groupsView = await createView(tenant, { name: 'Groups View', visibility: 'groups', sharedGroupIds: [sharedGroup.id] });

    const ownerList = await asUser(personalOwner).get('/views');
    expect(items<ViewsResponseItem>(ownerList).map((item) => item.name)).toContain('Personal View');

    const otherList = await asUser(otherAgent).get('/views');
    const otherNames = items<ViewsResponseItem>(otherList).map((item) => item.name);
    expect(otherNames).not.toContain('Personal View');
    expect(otherNames).not.toContain('Roles View');
    expect(otherNames).not.toContain('Groups View');

    const sharedRoleUser = await createUser(tenant, { roles: [{ id: sharedRole.id }] });
    const sharedRoleList = await asUser(sharedRoleUser).get('/views');
    expect(items<ViewsResponseItem>(sharedRoleList).map((item) => item.name)).toContain('Roles View');

    // Groups View: visible only to a viewer with access to sharedGroup (Admin gets full access to
    // every group it creates, so use admin to prove groups-visibility works at all).
    const adminList = await asUser(admin).get('/views');
    expect(items<ViewsResponseItem>(adminList).map((item) => item.name)).toContain('Groups View');

    expect(personal.tenant.id).toBe(tenant.id);
    expect(rolesView.tenant.id).toBe(tenant.id);
    expect(groupsView.tenant.id).toBe(tenant.id);
  });
});

describe('403 without view.view; 404 for another tenant\'s view', () => {
  it('GET /views is 403 PERMISSION_DENIED without view.view', async () => {
    const response = await asUser(noPermissionUser).get('/views');
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('GET /views/{id} is 403 PERMISSION_DENIED without view.view', async () => {
    const visible = await asUser(admin).get('/views');
    const viewId = items<ViewsResponseItem>(visible)[0]!.id;
    const response = await asUser(noPermissionUser).get(`/views/${viewId}`);
    expect(response.status).toBe(403);
    expect(response.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('a tenant B admin (who has view.view) gets 404 for tenant A\'s view, same as an unknown id', async () => {
    const tenantB = await createTenant();
    const otherAdmin = await createUser(tenantB, { roles: ['admin'] });

    const visible = await asUser(admin).get('/views');
    const viewId = items<ViewsResponseItem>(visible)[0]!.id;

    const cross = await asUser(otherAdmin).get(`/views/${viewId}`);
    const unknown = await asUser(otherAdmin).get(`/views/${uuidv7()}`);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect(cross.body).toEqual(errorBody('VIEW_NOT_FOUND'));
  });

  it('GET /tickets?viewId= is 404 for another tenant\'s view id', async () => {
    const tenantB = await createTenant();
    const otherAdmin = await createUser(tenantB, { roles: ['admin'] });

    const visible = await asUser(admin).get('/views');
    const viewId = items<ViewsResponseItem>(visible)[0]!.id;

    const cross = await asUser(otherAdmin).get(`/tickets?viewId=${viewId}`);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(errorBody('VIEW_NOT_FOUND'));
  });
});
