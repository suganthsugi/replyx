import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * `GET /tickets/{id}/mention-candidates` (P10-2): the @mention picker for internal notes. Needs
 * `ticket.edit` on the ticket's group (not `user.view`), and lists only active staff who can view
 * that group's tickets, as id, name and avatar. The success / 403 / cross-tenant 404 triad plus
 * the filters.
 */

const errorBody = (code: string) => ({ error: expect.objectContaining({ code, message: expect.any(String) as string }) as object });

const VIEW_EDIT = { view: true, create: false, edit: true, delete: false };
const VIEW_ONLY = { view: true, create: false, edit: false, delete: false };

interface Candidate {
  id: string;
  name: string;
  avatarUrl: string | null;
}

let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  await getTestApp();
  other = await createTenant();
});

// Candidates are tenant-wide, so each test gets its own tenant to keep the expected lists exact.
beforeEach(async () => {
  tenant = await createTenant();
});

async function ticketIn(group: string | null) {
  const customer = await createUser(tenant, { roles: ['customer'] });
  return createTicket(tenant, { customer, group, state: 'open' });
}

const url = (ticketId: string, query?: string) =>
  `/tickets/${ticketId}/mention-candidates${query === undefined ? '' : `?${query}`}`;
const withQ = (ticketId: string, q: string) => url(ticketId, `q=${encodeURIComponent(q)}`);

describe('GET /tickets/{id}/mention-candidates', () => {
  it('lists active staff who can view the ticket by name, without user.view or any admin data (success)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: VIEW_EDIT }] });
    const ticket = await ticketIn(group.id);

    const caller = await createUser(tenant, { roles: ['agent'], name: 'Zed Agent' });
    const alex = await createUser(tenant, { roles: ['agent'], name: 'Alex Agent' });
    const admin = await createUser(tenant, { roles: ['admin'], name: 'Ada Admin' });
    // Not candidates: deactivated, a customer, staff without access to this group, and staff whose
    // role lacks the ticket.view permission even though it has the group's view flag.
    await createUser(tenant, { roles: ['agent'], name: 'Alma Gone', status: 'deactivated' });
    await createUser(tenant, { roles: ['customer'], name: 'Alice Customer' });
    const otherGroup = await createGroup(tenant);
    const elsewhere = await createRole(tenant, {
      permissions: ['ticket.view', 'ticket.edit'],
      groups: [{ group: otherGroup.id, flags: VIEW_EDIT }],
    });
    await createUser(tenant, { roles: [{ id: elsewhere.id }], name: 'Alan Elsewhere' });
    const noViewKey = await createRole(tenant, { permissions: ['ticket.edit'], groups: [{ group: group.id, flags: VIEW_EDIT }] });
    await createUser(tenant, { roles: [{ id: noViewKey.id }], name: 'Aldo NoViewKey' });

    const response = await asUser(caller).get(url(ticket.id));
    expect(response.status).toBe(200);
    const { items } = response.body as { items: Candidate[] };
    expect(items.map((item) => item.name)).toEqual(['Ada Admin', 'Alex Agent', 'Zed Agent']);
    expect(items.find((item) => item.name === 'Alex Agent')).toEqual({ id: alex.id, name: 'Alex Agent', avatarUrl: null });
    expect(items.find((item) => item.name === 'Ada Admin')?.id).toBe(admin.id);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['avatarUrl', 'id', 'name']);
  });

  it('matches q as a case-insensitive name prefix, treating % and _ literally', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: VIEW_EDIT }] });
    const ticket = await ticketIn(group.id);
    const caller = await createUser(tenant, { roles: ['agent'], name: 'Zed Agent' });
    await createUser(tenant, { roles: ['agent'], name: 'Alex Agent' });
    await createUser(tenant, { roles: ['agent'], name: 'Malex Agent' });
    await createUser(tenant, { roles: ['agent'], name: '50% Agent' });

    const names = async (q: string) =>
      ((await asUser(caller).get(withQ(ticket.id, q))).body as { items: Candidate[] }).items.map((item) => item.name);
    expect(await names('alex')).toEqual(['Alex Agent']);
    expect(await names('ALEX')).toEqual(['Alex Agent']);
    expect(await names('lex')).toEqual([]);
    expect(await names('50%')).toEqual(['50% Agent']);
    expect(await names('%')).toEqual([]);
    expect(await names('_')).toEqual([]);
    expect(await names('  zed ')).toEqual(['Zed Agent']);
  });

  it('returns at most 20 candidates, ordered by name', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: VIEW_EDIT }] });
    const ticket = await ticketIn(group.id);
    const caller = await createUser(tenant, { roles: ['agent'], name: 'Caller Agent' });
    for (let index = 10; index < 32; index += 1) {
      await createUser(tenant, { roles: ['agent'], name: `Limit ${index}`, session: false });
    }

    const response = await asUser(caller).get(withQ(ticket.id, 'Limit'));
    const names = (response.body as { items: Candidate[] }).items.map((item) => item.name);
    expect(names).toHaveLength(20);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe('Limit 10');
  });

  it('rejects unknown query parameters and an over-long q (400)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: VIEW_EDIT }] });
    const ticket = await ticketIn(group.id);
    const caller = await createUser(tenant, { roles: ['agent'] });

    const unknownKey = await asUser(caller).get(url(ticket.id, `tenantId=${uuidv7()}`));
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body).toEqual(errorBody('VALIDATION_FAILED'));
    const tooLong = await asUser(caller).get(withQ(ticket.id, 'x'.repeat(81)));
    expect(tooLong.status).toBe(400);
  });

  it('refuses a staff member without ticket.edit on the group (403), and one without the permission (403)', async () => {
    const group = await createGroup(tenant, { access: [{ role: 'agent', flags: VIEW_ONLY }] });
    const ticket = await ticketIn(group.id);
    const viewer = await createUser(tenant, { roles: ['agent'] });
    const bystander = await createUser(tenant, { roles: [] });

    const denied = await asUser(viewer).get(url(ticket.id));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(errorBody('PERMISSION_DENIED'));
    const noPermission = await asUser(bystander).get(url(ticket.id));
    expect(noPermission.status).toBe(403);
    expect(noPermission.body).toEqual(errorBody('PERMISSION_DENIED'));
  });

  it('hides a ticket in a group the caller cannot view, same as an unknown id (404)', async () => {
    const hidden = await createGroup(tenant);
    const ticket = await ticketIn(hidden.id);
    const agent = await createUser(tenant, { roles: ['agent'] });

    const cross = await asUser(agent).get(url(ticket.id));
    const unknown = await asUser(agent).get(url(uuidv7()));
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
  });

  it('hides a ticket in another tenant from an admin who has the permission there (404)', async () => {
    const ticket = await ticketIn(null);
    const otherAdmin = await createUser(other, { roles: ['admin'] });

    const cross = await asUser(otherAdmin).get(url(ticket.id));
    const unknown = await asUser(otherAdmin).get(url(uuidv7()));
    expect([cross.status, cross.body]).toEqual([404, unknown.body]);
    expect(cross.body).toEqual(errorBody('TICKET_NOT_FOUND'));
  });

  it('serves an Ungrouped ticket, listing staff with view on Ungrouped', async () => {
    const ticket = await ticketIn(null);
    const admin = await createUser(tenant, { roles: ['admin'], name: 'Unique Ungrouped Admin' });

    const response = await asUser(admin).get(withQ(ticket.id, 'Unique Ungrouped'));
    expect(response.status).toBe(200);
    expect((response.body as { items: Candidate[] }).items.map((item) => item.id)).toEqual([admin.id]);
  });
});
