import { beforeAll, describe, expect, it } from 'vitest';

import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createTicket, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * The view builder (T209, US10 acceptance 1-4): `POST /views`, `PUT /views/{id}` and
 * `POST /views/preview-count`. Success, 403 and cross-tenant 404 for each, plus sharing rules,
 * per-viewer ticket access, the `views.counts_changed` outbox hint and the `view.*` audit rows.
 * Body-keyed non-GET routes are not in the generated cross-tenant suite, so their cross-tenant
 * cases are here.
 */

interface ViewBody {
  id: string;
  name: string;
  visibility: string;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
  count: number;
  editable: boolean;
  system: string | null;
}
interface Failure {
  error: { code: string; details?: { path: string; issue: string }[] };
}

const body = <T>(response: { body: unknown }) => response.body as T;
const failure = (response: { body: unknown }) => (response.body as Failure).error;
const names = (response: { body: unknown }) => body<{ items: ViewBody[] }>(response).items.map((item) => item.name);

const CONDITIONS = { op: 'and', items: [{ field: 'state', operator: 'is_not', value: 'closed' }] };

function viewInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `View ${uuidv7()}`,
    visibility: 'personal',
    conditions: CONDITIONS,
    sort: [{ field: 'updated_at', direction: 'desc' }],
    columns: ['number', 'title', 'state', 'updated_at'],
    ...overrides,
  };
}

class Inspect extends TenantRepository {
  audit(tx: TenantTransaction, resourceId: string) {
    return this.selectFrom(tx, 'audit_logs').select(['action', 'details']).where('resource_id', '=', resourceId).orderBy('id').execute();
  }

  events(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events').select(['payload', 'streams']).where('type', '=', type).orderBy('id').execute();
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-inspect' });
  return (await service(UnitOfWork)).withTenantReadOnly(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

const STAFF = ['view.view', 'view.create', 'ticket.view'];

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let agent: TestUser; // seed Agent: view.create, no view.share / view.edit
let otherAgent: TestUser;
let manager: TestUser; // seed Manager: view.edit, no view.share
let sharer: TestUser; // custom: view.create + view.share + view.edit
let noPerm: TestUser;
let adminB: TestUser;
let group1: { id: string };
let viewer1: TestUser; // ticket access to group1 only
let viewer2: TestUser; // ticket access to group2 only
let role1: { id: string };

async function makeView(user: TestUser, overrides: Record<string, unknown> = {}): Promise<ViewBody> {
  const response = await asUser(user).post('/views', viewInput(overrides));
  expect(response.status).toBe(201);
  return body<ViewBody>(response);
}

/** A tenant with a sharer (view.share + view.edit) so tests can inspect its outbox/audit alone. */
async function sharerIn(tenant: TestTenant, extraRoleIds: string[] = []): Promise<TestUser> {
  const role = await createRole(tenant, { permissions: [...STAFF, 'view.share', 'view.edit'] });
  return createUser(tenant, { roles: [{ id: role.id }, ...extraRoleIds.map((id) => ({ id }))] });
}

beforeAll(async () => {
  await getTestApp();
  a = await createTenant();
  b = await createTenant();
  admin = await createUser(a, { roles: ['admin'] });
  agent = await createUser(a, { roles: ['agent'] });
  otherAgent = await createUser(a, { roles: ['agent'] });
  manager = await createUser(a, { roles: ['manager'] });
  sharer = await sharerIn(a);
  const none = await createRole(a, { permissions: [] });
  noPerm = await createUser(a, { roles: [{ id: none.id }] });
  adminB = await createUser(b, { roles: ['admin'] });

  group1 = await createGroup(a);
  const group2 = await createGroup(a);
  role1 = await createRole(a, { permissions: STAFF, groups: [{ group: group1.id, flags: { view: true } }] });
  const role2 = await createRole(a, { permissions: STAFF, groups: [{ group: group2.id, flags: { view: true } }] });
  viewer1 = await createUser(a, { roles: [{ id: role1.id }] });
  viewer2 = await createUser(a, { roles: [{ id: role2.id }] });
});

describe('POST /views', () => {
  it('201: a personal view for a user with view.create, visible to its owner', async () => {
    const created = await makeView(agent, { name: 'Mine', description: 'desc' });
    expect(created).toMatchObject({ name: 'Mine', visibility: 'personal', sharedRoleIds: [], sharedGroupIds: [], system: null, editable: true });
    expect((await asUser(agent).get(`/views/${created.id}`)).status).toBe(200);
  });

  it('403 PERMISSION_DENIED without view.create', async () => {
    const response = await asUser(noPerm).post('/views', viewInput());
    expect(response.status).toBe(403);
    expect(failure(response).code).toBe('PERMISSION_DENIED');
  });

  it('201: a shared view (all_staff, roles, groups) for a user with view.share', async () => {
    const staff = await makeView(sharer, { visibility: 'all_staff' });
    const roles = await makeView(sharer, { visibility: 'roles', sharedRoleIds: [role1.id] });
    const groups = await makeView(sharer, { visibility: 'groups', sharedGroupIds: [group1.id] });
    expect(staff.visibility).toBe('all_staff');
    expect(roles.sharedRoleIds).toEqual([role1.id]);
    expect(groups.sharedGroupIds).toEqual([group1.id]);
  });

  it('403 when sharing without view.share (agent, manager), and nothing is stored', async () => {
    for (const user of [agent, manager]) {
      const name = `Denied ${uuidv7()}`;
      const response = await asUser(user).post('/views', viewInput({ name, visibility: 'all_staff' }));
      expect(response.status).toBe(403);
      expect(failure(response).code).toBe('PERMISSION_DENIED');
      expect(names(await asUser(admin).get('/views'))).not.toContain(name);
    }
  });

  it('400 for role and group ids that do not exist in the tenant, including tenant B ids', async () => {
    const roleB = await createRole(b, { permissions: [] });
    const groupB = await createGroup(b);
    const unknownRole = await asUser(admin).post('/views', viewInput({ visibility: 'roles', sharedRoleIds: [uuidv7()] }));
    const crossRole = await asUser(admin).post('/views', viewInput({ visibility: 'roles', sharedRoleIds: [roleB.id] }));
    const unknownGroup = await asUser(admin).post('/views', viewInput({ visibility: 'groups', sharedGroupIds: [uuidv7()] }));
    const crossGroup = await asUser(admin).post('/views', viewInput({ visibility: 'groups', sharedGroupIds: [groupB.id] }));
    for (const response of [unknownRole, crossRole]) {
      expect(response.status).toBe(400);
      expect(failure(response).details).toEqual([{ path: 'sharedRoleIds.0', issue: 'invalid_value' }]);
    }
    for (const response of [unknownGroup, crossGroup]) {
      expect(response.status).toBe(400);
      expect(failure(response).details).toEqual([{ path: 'sharedGroupIds.0', issue: 'invalid_value' }]);
    }
    expect(crossRole.body).toEqual(unknownRole.body);
    expect(crossGroup.body).toEqual(unknownGroup.body);
  });

  it('cross-tenant: a tenant B admin naming tenant A role/group ids gets 400 and nothing is created', async () => {
    const name = `Leak ${uuidv7()}`;
    const role = await asUser(adminB).post('/views', viewInput({ name, visibility: 'roles', sharedRoleIds: [role1.id] }));
    const group = await asUser(adminB).post('/views', viewInput({ name, visibility: 'groups', sharedGroupIds: [group1.id] }));
    expect([role.status, failure(role).details]).toEqual([400, [{ path: 'sharedRoleIds.0', issue: 'invalid_value' }]]);
    expect([group.status, failure(group).details]).toEqual([400, [{ path: 'sharedGroupIds.0', issue: 'invalid_value' }]]);
    expect(names(await asUser(adminB).get('/views'))).not.toContain(name);
    expect(names(await asUser(admin).get('/views'))).not.toContain(name);
  });

  it('400 too_few for roles/groups visibility without ids', async () => {
    const roles = await asUser(admin).post('/views', viewInput({ visibility: 'roles' }));
    const groups = await asUser(admin).post('/views', viewInput({ visibility: 'groups', sharedGroupIds: [] }));
    expect(roles.status).toBe(400);
    expect(failure(roles).details).toEqual([{ path: 'sharedRoleIds', issue: 'too_few' }]);
    expect(failure(groups).details).toEqual([{ path: 'sharedGroupIds', issue: 'too_few' }]);
  });

  it.each([
    ['an unknown field', { conditions: { op: 'and', items: [{ field: 'nope', operator: 'is', value: 'x' }] } }],
    ['an operator that does not fit the field', { conditions: { op: 'and', items: [{ field: 'state', operator: 'before', value: 'now' }] } }],
    ['a condition (not a group) at the root', { conditions: { field: 'state', operator: 'is', value: 'open' } }],
    ['more than 3 sort items', { sort: ['updated_at', 'created_at', 'priority', 'number'].map((field) => ({ field, direction: 'asc' })) }],
    ['a duplicate sort field', { sort: [{ field: 'priority', direction: 'asc' }, { field: 'priority', direction: 'desc' }] }],
    ['a duplicate column', { columns: ['number', 'number'] }],
    ['an unknown column', { columns: ['number', 'nope'] }],
    ['an empty name', { name: '   ' }],
    ['an unknown property', { extra: true }],
  ])('400 VALIDATION_FAILED for %s', async (_label, overrides) => {
    const response = await asUser(admin).post('/views', viewInput(overrides));
    expect(response.status).toBe(400);
    expect(failure(response).code).toBe('VALIDATION_FAILED');
    expect(failure(response).details?.length).toBeGreaterThan(0);
  });
});

describe('PUT /views/{id}', () => {
  it('200: the owner edits a personal view', async () => {
    const view = await makeView(agent);
    const response = await asUser(agent).put(`/views/${view.id}`, viewInput({ name: 'Renamed', columns: ['number', 'title'] }));
    expect(response.status).toBe(200);
    expect(body<ViewBody>(response)).toMatchObject({ id: view.id, name: 'Renamed', visibility: 'personal' });
  });

  it('404 VIEW_NOT_FOUND for another staff user on a personal view, equal to an unknown id', async () => {
    const view = await makeView(agent);
    const other = await asUser(otherAgent).put(`/views/${view.id}`, viewInput());
    const unknown = await asUser(otherAgent).put(`/views/${uuidv7()}`, viewInput());
    expect(other.status).toBe(404);
    expect(other.body).toEqual(unknown.body);
    expect(failure(other).code).toBe('VIEW_NOT_FOUND');
    // even an admin cannot see or edit somebody else's personal view
    expect((await asUser(admin).put(`/views/${view.id}`, viewInput())).status).toBe(404);
  });

  it('403 without view.view', async () => {
    const view = await makeView(agent);
    const response = await asUser(noPerm).put(`/views/${view.id}`, viewInput());
    expect(response.status).toBe(403);
    expect(failure(response).code).toBe('PERMISSION_DENIED');
  });

  it('a default view needs view.edit and keeps its sharing', async () => {
    const list = body<{ items: ViewBody[] }>(await asUser(admin).get('/views')).items;
    const def = list.find((item) => item.system === 'all_open')!;

    const denied = await asUser(agent).put(`/views/${def.id}`, viewInput({ visibility: 'all_staff' }));
    expect(denied.status).toBe(403);
    expect(failure(denied).code).toBe('PERMISSION_DENIED');

    const reshared = await asUser(manager).put(`/views/${def.id}`, viewInput({ visibility: 'personal' }));
    expect(reshared.status).toBe(400);
    expect(failure(reshared).details).toEqual([{ path: 'visibility', issue: 'invalid_value' }]);

    const ok = await asUser(manager).put(`/views/${def.id}`, viewInput({ name: def.name, visibility: 'all_staff' }));
    expect(ok.status).toBe(200);
    expect(body<ViewBody>(ok)).toMatchObject({ id: def.id, system: 'all_open', visibility: 'all_staff' });
  });

  it('a shared non-default view: view.edit to edit, view.share to change the sharing', async () => {
    const view = await makeView(sharer, { visibility: 'all_staff' });

    const noEdit = await asUser(agent).put(`/views/${view.id}`, viewInput({ visibility: 'all_staff' }));
    expect(noEdit.status).toBe(403);

    const edit = await asUser(manager).put(`/views/${view.id}`, viewInput({ name: 'Manager edit', visibility: 'all_staff' }));
    expect(edit.status).toBe(200);
    expect(body<ViewBody>(edit).name).toBe('Manager edit');

    const reshare = await asUser(manager).put(`/views/${view.id}`, viewInput({ visibility: 'roles', sharedRoleIds: [role1.id] }));
    expect(reshare.status).toBe(403);
    expect(failure(reshare).code).toBe('PERMISSION_DENIED');

    const shared = await asUser(sharer).put(`/views/${view.id}`, viewInput({ visibility: 'roles', sharedRoleIds: [role1.id] }));
    expect(shared.status).toBe(200);
    expect(body<ViewBody>(shared)).toMatchObject({ visibility: 'roles', sharedRoleIds: [role1.id] });
  });

  it('a personal view can be shared by its owner only with view.share', async () => {
    const mine = await makeView(agent);
    const denied = await asUser(agent).put(`/views/${mine.id}`, viewInput({ visibility: 'all_staff' }));
    expect(denied.status).toBe(403);

    const own = await makeView(sharer);
    const shared = await asUser(sharer).put(`/views/${own.id}`, viewInput({ visibility: 'all_staff' }));
    expect(shared.status).toBe(200);
    expect(names(await asUser(otherAgent).get('/views'))).toContain(body<ViewBody>(shared).name);
  });

  it('shared -> personal needs view.create and the editor becomes the owner', async () => {
    const view = await makeView(sharer, { visibility: 'all_staff', name: 'Going private' });
    const response = await asUser(manager).put(`/views/${view.id}`, viewInput({ name: 'Going private', visibility: 'personal' }));
    expect(response.status).toBe(200);
    expect(body<ViewBody>(response).visibility).toBe('personal');
    expect((await asUser(manager).get(`/views/${view.id}`)).status).toBe(200);
    expect((await asUser(sharer).get(`/views/${view.id}`)).status).toBe(404);
  });

  it('400 for a group of another tenant on update', async () => {
    const view = await makeView(sharer, { visibility: 'all_staff' });
    const groupB = await createGroup(b);
    const response = await asUser(sharer).put(`/views/${view.id}`, viewInput({ visibility: 'groups', sharedGroupIds: [groupB.id] }));
    expect(response.status).toBe(400);
    expect(failure(response).details).toEqual([{ path: 'sharedGroupIds.0', issue: 'invalid_value' }]);
  });

  it('cross-tenant: tenant A view id is 404 VIEW_NOT_FOUND for a tenant B admin, identical to a random id', async () => {
    const view = await makeView(sharer, { visibility: 'all_staff' });
    const cross = await asUser(adminB).put(`/views/${view.id}`, viewInput());
    const unknown = await asUser(adminB).put(`/views/${uuidv7()}`, viewInput());
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(unknown.body);
    expect(failure(cross).code).toBe('VIEW_NOT_FOUND');
    expect(body<ViewBody>(await asUser(sharer).get(`/views/${view.id}`)).name).toBe(view.name);
  });
});

describe('POST /views/preview-count', () => {
  it('200 { count } for an unsaved tree, counting only tickets in groups the viewer can access', async () => {
    const t = await createTenant();
    const tAdmin = await createUser(t, { roles: ['admin'] });
    const g1 = await createGroup(t);
    const g2 = await createGroup(t);
    const r1 = await createRole(t, { permissions: STAFF, groups: [{ group: g1.id, flags: { view: true } }] });
    const v1 = await createUser(t, { roles: [{ id: r1.id }] });
    const customer = await createUser(t, { roles: ['customer'] });
    await createTicket(t, { customer, group: g1.id, state: 'open' });
    await createTicket(t, { customer, group: g1.id, state: 'open' });
    await createTicket(t, { customer, group: g2.id, state: 'open' });
    await createTicket(t, { customer, group: g2.id, state: 'closed' });

    const tree = { conditions: CONDITIONS };
    const adminCount = await asUser(tAdmin).post('/views/preview-count', tree);
    const viewerCount = await asUser(v1).post('/views/preview-count', tree);
    expect(adminCount.status).toBe(200);
    expect(adminCount.body).toEqual({ count: 3 });
    expect(viewerCount.body).toEqual({ count: 2 });

    const closed = { conditions: { op: 'and', items: [{ field: 'state', operator: 'is', value: 'closed' }] } };
    expect((await asUser(tAdmin).post('/views/preview-count', closed)).body).toEqual({ count: 1 });
    expect((await asUser(v1).post('/views/preview-count', closed)).body).toEqual({ count: 0 });
  });

  it('403 without view.view', async () => {
    const response = await asUser(noPerm).post('/views/preview-count', { conditions: CONDITIONS });
    expect(response.status).toBe(403);
    expect(failure(response).code).toBe('PERMISSION_DENIED');
  });

  it('400 for an invalid tree', async () => {
    const response = await asUser(admin).post('/views/preview-count', {
      conditions: { op: 'and', items: [{ field: 'state', operator: 'before', value: 'now' }] },
    });
    expect(response.status).toBe(400);
    expect(failure(response).code).toBe('VALIDATION_FAILED');
  });

  it('cross-tenant: counts only the caller tenant, and a tenant A group id in the tree matches nothing', async () => {
    const tb = await createTenant();
    const bAdmin = await createUser(tb, { roles: ['admin'] });
    const customerA = await createUser(a, { roles: ['customer'] });
    await createTicket(a, { customer: customerA, group: group1.id, state: 'open' });

    const all = await asUser(bAdmin).post('/views/preview-count', { conditions: CONDITIONS });
    expect(all.body).toEqual({ count: 0 });
    const byGroup = await asUser(bAdmin).post('/views/preview-count', {
      conditions: { op: 'and', items: [{ field: 'group', operator: 'is', value: group1.id }] },
    });
    expect(byGroup.status).toBe(200);
    expect(byGroup.body).toEqual({ count: 0 });
  });
});

describe('sharing and per-viewer ticket access', () => {
  it('a view shared with a role appears for that role members only', async () => {
    const view = await makeView(sharer, { visibility: 'roles', sharedRoleIds: [role1.id] });
    expect(names(await asUser(viewer1).get('/views'))).toContain(view.name);
    expect((await asUser(viewer1).get(`/views/${view.id}`)).status).toBe(200);
    for (const other of [viewer2, agent, otherAgent]) {
      expect(names(await asUser(other).get('/views'))).not.toContain(view.name);
      expect((await asUser(other).get(`/views/${view.id}`)).status).toBe(404);
    }
  });

  it('shared views are visible per group access and list/count only tickets each viewer may see', async () => {
    const t = await createTenant();
    const tSharer = await sharerIn(t);
    const g1 = await createGroup(t);
    const g2 = await createGroup(t);
    const r1 = await createRole(t, { permissions: STAFF, groups: [{ group: g1.id, flags: { view: true } }] });
    const r2 = await createRole(t, { permissions: STAFF, groups: [{ group: g2.id, flags: { view: true } }] });
    const v1 = await createUser(t, { roles: [{ id: r1.id }] });
    const v2 = await createUser(t, { roles: [{ id: r2.id }] });
    const tAdmin = await createUser(t, { roles: ['admin'] });
    const customer = await createUser(t, { roles: ['customer'] });
    const t1 = await createTicket(t, { customer, group: g1.id, state: 'open' });
    const t2 = await createTicket(t, { customer, group: g2.id, state: 'open' });

    const groupsView = await makeView(tSharer, { visibility: 'groups', sharedGroupIds: [g1.id] });
    expect(names(await asUser(v1).get('/views'))).toContain(groupsView.name);
    expect(names(await asUser(v2).get('/views'))).not.toContain(groupsView.name);
    expect((await asUser(v2).get(`/views/${groupsView.id}`)).status).toBe(404);
    expect((await asUser(v2).get(`/tickets?viewId=${groupsView.id}`)).status).toBe(404);

    const ids = async (user: TestUser, viewId: string) => {
      const response = await asUser(user).get(`/tickets?viewId=${viewId}&limit=100`);
      expect(response.status).toBe(200);
      return body<{ items: { id: string }[] }>(response).items.map((item) => item.id).sort();
    };

    // all_staff: one view for everyone, each viewer sees only tickets in their groups
    const shared = await makeView(tAdmin, { visibility: 'all_staff' });
    expect(await ids(v1, shared.id)).toEqual([t1.id]);
    expect(await ids(v2, shared.id)).toEqual([t2.id]);
    expect(await ids(tAdmin, shared.id)).toEqual([t1.id, t2.id].sort());
    expect(await ids(v1, groupsView.id)).toEqual([t1.id]);

    expect(body<ViewBody>(await asUser(v1).get(`/views/${shared.id}`)).count).toBe(1);
    expect(body<ViewBody>(await asUser(v2).get(`/views/${shared.id}`)).count).toBe(1);
    expect(body<ViewBody>(await asUser(tAdmin).get(`/views/${shared.id}`)).count).toBe(2);
  });

  it('a personal view never appears for another user (list, get, tickets)', async () => {
    const view = await makeView(agent, { name: `Private ${uuidv7()}` });
    expect(names(await asUser(agent).get('/views'))).toContain(view.name);
    for (const other of [otherAgent, admin, manager, sharer]) {
      expect(names(await asUser(other).get('/views'))).not.toContain(view.name);
      const get = await asUser(other).get(`/views/${view.id}`);
      const unknown = await asUser(other).get(`/views/${uuidv7()}`);
      expect(get.status).toBe(404);
      expect(get.body).toEqual(unknown.body);
      expect((await asUser(other).get(`/tickets?viewId=${view.id}`)).status).toBe(404);
    }
  });

  it('a shared view from tenant A never appears in tenant B', async () => {
    const view = await makeView(sharer, { visibility: 'all_staff' });
    expect(names(await asUser(adminB).get('/views'))).not.toContain(view.name);
  });
});

describe('outbox hint and audit trail', () => {
  it('appends views.counts_changed on create and update, naming only the viewers who see the view', async () => {
    const t = await createTenant();
    const g1 = await createGroup(t);
    const r1 = await createRole(t, { permissions: STAFF, groups: [{ group: g1.id, flags: { view: true } }] });
    // A creator who shares with roles it does not hold cannot see (or edit) the view afterwards.
    const tSharer = await sharerIn(t, [r1.id]);
    const member = await createUser(t, { roles: [{ id: r1.id }] });
    const outsider = await createUser(t, { roles: ['agent'] });

    const view = await makeView(tSharer, { visibility: 'roles', sharedRoleIds: [r1.id] });
    const created = await inspect(t, (tx, repo) => repo.events(tx, 'views.counts_changed'));
    const last = created.at(-1)!;
    expect(last.payload).toEqual({ viewIds: [view.id] });
    expect(last.streams).toContain(`views:${tSharer.id}`);
    expect(last.streams).toContain(`views:${member.id}`);
    expect(last.streams).not.toContain(`views:${outsider.id}`);

    const update = await asUser(tSharer).put(`/views/${view.id}`, viewInput({ name: 'Widened', visibility: 'all_staff' }));
    expect(update.status).toBe(200);
    const events = await inspect(t, (tx, repo) => repo.events(tx, 'views.counts_changed'));
    expect(events).toHaveLength(created.length + 1);
    expect(events.at(-1)!.streams).toEqual(expect.arrayContaining([`views:${tSharer.id}`, `views:${member.id}`, `views:${outsider.id}`]));
  });

  it('a personal write announces to the owner only', async () => {
    const t = await createTenant();
    const owner = await createUser(t, { roles: ['agent'] });
    const other = await createUser(t, { roles: ['agent'] });
    const view = await makeView(owner);
    const events = await inspect(t, (tx, repo) => repo.events(tx, 'views.counts_changed'));
    expect(events.at(-1)!.payload).toEqual({ viewIds: [view.id] });
    expect(events.at(-1)!.streams).toEqual([`views:${owner.id}`]);
    expect(events.at(-1)!.streams).not.toContain(`views:${other.id}`);
  });

  it('audits shared writes as view.created / view.updated and not purely personal ones', async () => {
    const member = await sharerIn(a, [role1.id]);
    const shared = await makeView(member, { visibility: 'roles', sharedRoleIds: [role1.id], name: 'Audited' });
    expect((await asUser(member).put(`/views/${shared.id}`, viewInput({ name: 'Audited 2', visibility: 'all_staff' }))).status).toBe(200);
    const rows = await inspect(a, (tx, repo) => repo.audit(tx, shared.id));
    expect(rows.map((row) => row.action)).toEqual(['view.created', 'view.updated']);
    expect(rows[0]!.details).toMatchObject({ name: 'Audited', visibility: 'roles', sharedRoleIds: [role1.id] });
    expect(rows[1]!.details).toMatchObject({ name: 'Audited 2', visibility: 'all_staff' });

    const personal = await makeView(agent);
    expect((await asUser(agent).put(`/views/${personal.id}`, viewInput({ name: 'Still mine' }))).status).toBe(200);
    expect(await inspect(a, (tx, repo) => repo.audit(tx, personal.id))).toEqual([]);
  });
});
