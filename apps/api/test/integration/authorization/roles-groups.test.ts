import { Global, Module } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { definePermissions, type ModulePermissions } from '../../../src/authorization/registry/module-permissions.js';
import { PermissionRegistry } from '../../../src/authorization/registry/registry.service.js';
import { GROUP_TICKET_STATS, type GroupTicketStats } from '../../../src/groups/groups.service.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { getTestApp, service } from '../../support/app.js';
import { createGroup, createRole, createTenant, createUser, type TestTenant, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

import type { Test } from 'supertest';

/**
 * Roles, permissions and groups (T095; authorization/roles.*, groups/groups.*, openapi.yaml
 * `/permissions`, `/roles*`, `/groups*`). Every endpoint gets the triad: success, 403 without the
 * permission, cross-tenant 404 equal to the unknown-id body (testing-conventions rule 6).
 */

const UNKNOWN_ID = '01920000-0000-7000-8000-000000000000';
const NONE = { view: false, create: false, edit: false, delete: false };
const FULL = { view: true, create: true, edit: true, delete: true };

interface GroupAccessEntry {
  groupId: string | null;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}
interface RoleBody {
  id: string;
  name: string;
  description?: string;
  system: string | null;
  permissions: string[];
  groupAccess: GroupAccessEntry[];
  userCount: number;
}
interface GroupBody {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive';
  openTicketCount: number;
}

const body = <T>(response: { body: unknown }) => response.body as T;
const items = <T>(response: { body: unknown }) => (response.body as { items: T[] }).items;
const failure = (response: { body: unknown }) =>
  response.body as { error: { code: string; details?: { path: string; issue: string }[] } };

/** The tickets module's stats (US6), switched per test; registered in this file's single app. */
const stats = { hasTickets: false, openByGroup: new Map<string, number>(), openByOwner: new Map<string, number>() };

const ticketStats: GroupTicketStats = {
  openTicketCounts: (_tx, groupIds) => Promise.resolve(new Map(groupIds.filter((id) => stats.openByGroup.has(id)).map((id) => [id, stats.openByGroup.get(id) ?? 0]))),
  openTicketCountsByOwner: (_tx, userIds) =>
    Promise.resolve(new Map(userIds.filter((id) => stats.openByOwner.has(id)).map((id) => [id, stats.openByOwner.get(id) ?? 0]))),
  hasTickets: () => Promise.resolve(stats.hasTickets),
};

@Global()
@Module({ providers: [{ provide: GROUP_TICKET_STATS, useValue: ticketStats }], exports: [GROUP_TICKET_STATS] })
class TicketStatsModule {}

class Inspect extends TenantRepository {
  audit(tx: TenantTransaction, resourceId: string) {
    return this.selectFrom(tx, 'audit_logs').select(['action', 'details']).where('resource_id', '=', resourceId).orderBy('id').execute();
  }

  events(tx: TenantTransaction, type: string) {
    return this.selectFrom(tx, 'outbox_events').select(['payload', 'streams']).where('type', '=', type).orderBy('id').execute();
  }

  groupAccess(tx: TenantTransaction, groupId: string) {
    return this.selectFrom(tx, 'role_group_access').select(['role_id', 'can_view', 'can_create', 'can_edit', 'can_delete']).where('group_id', '=', groupId).execute();
  }

  permissionsOf(tx: TenantTransaction, roleId: string) {
    return this.selectFrom(tx, 'role_permissions').select('permission_key').where('role_id', '=', roleId).execute();
  }

  async accessVersion(tx: TenantTransaction): Promise<string> {
    const row = await tx.selectFrom('tenants').select('access_version').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return String(row.access_version);
  }
}

async function inspect<T>(tenant: TestTenant, fn: (tx: TenantTransaction, repo: Inspect) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'roles-groups-test' });
  return (await service(UnitOfWork)).withTenantReadOnly(ctx, (tx) => fn(tx, new Inspect(ctx)));
}

async function expectCrossTenant404(call: (id: string) => Promise<Test>, foreignId: string): Promise<void> {
  const cross = await call(foreignId);
  const unknown = await call(UNKNOWN_ID);
  expect(cross.status).toBe(404);
  expect(cross.body).toEqual(unknown.body);
}

let a: TestTenant;
let b: TestTenant;
let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;

beforeAll(async () => {
  await getTestApp({ imports: [TicketStatsModule] });
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [adminA, agentA, adminB] = await Promise.all([
    createUser(a, { roles: ['admin'] }),
    createUser(a, { roles: ['agent'] }),
    createUser(b, { roles: ['admin'] }),
  ]);
});

afterEach(() => {
  stats.hasTickets = false;
  stats.openByGroup.clear();
  stats.openByOwner.clear();
});

describe('GET /permissions', () => {
  it('lists the registry sorted by module, marking ticket.* as group scoped', async () => {
    const response = await asUser(adminA).get('/permissions');
    expect(response.status).toBe(200);
    const permissions = items<{ key: string; module: string; groupScoped: boolean }>(response);
    const registry = (await service(PermissionRegistry)).all();
    expect(permissions.map((p) => p.key).sort()).toEqual(registry.map((p) => p.key).sort());
    for (const permission of permissions) expect(permission.groupScoped).toBe(permission.key.startsWith('ticket.'));
    const modules = permissions.map((p) => p.module);
    expect(modules).toEqual([...modules].sort((x, y) => x.localeCompare(y)));
  });

  it('needs role.view', async () => {
    expect((await asUser(agentA).get('/permissions')).status).toBe(403);
  });
});

describe('roles', () => {
  it('GET /roles lists the tenant roles with user counts, never another tenant’s', async () => {
    const custom = await createRole(b, { permissions: ['ticket.view'] });
    const response = await asUser(adminA).get('/roles');
    expect(response.status).toBe(200);
    const roles = items<RoleBody>(response);
    expect(roles.map((r) => r.system).filter((s) => s !== null).sort()).toEqual(['admin', 'agent', 'customer', 'manager']);
    expect(roles.find((r) => r.system === 'admin')?.userCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(roles)).not.toContain(custom.id);
    expect((await asUser(agentA).get('/roles')).status).toBe(403);
  });

  it('POST /roles creates a custom role, audited, bumping the access version', async () => {
    const group = await createGroup(a);
    const before = await inspect(a, (tx, repo) => repo.accessVersion(tx));
    const response = await asUser(adminA).post('/roles', {
      name: 'Billing desk',
      description: 'Billing questions',
      permissions: ['ticket.view', 'ticket.edit'],
      groupAccess: [{ groupId: group.id, view: true, create: false, edit: true, delete: false }, { groupId: null, ...NONE, view: true }],
    });
    expect(response.status).toBe(201);
    const role = body<RoleBody>(response);
    expect(role).toMatchObject({ name: 'Billing desk', description: 'Billing questions', system: null, permissions: ['ticket.edit', 'ticket.view'], userCount: 0 });
    expect(role.groupAccess).toHaveLength(2);

    expect(BigInt(await inspect(a, (tx, repo) => repo.accessVersion(tx)))).toBeGreaterThan(BigInt(before));
    expect((await inspect(a, (tx, repo) => repo.audit(tx, role.id))).map((row) => row.action)).toEqual(['role.created']);
  });

  it('POST /roles refuses taken names (case-insensitive), unknown keys, duplicate and foreign groups', async () => {
    const existing = await createRole(a, { name: 'Night shift' });
    const foreignGroup = await createGroup(b);
    const admin = asUser(adminA);

    const taken = await admin.post('/roles', { name: 'NIGHT SHIFT', permissions: [], groupAccess: [] });
    expect(taken.status).toBe(409);
    expect(failure(taken).error.code).toBe('ROLE_NAME_TAKEN');
    // Names are unique per tenant only.
    expect((await asUser(adminB).post('/roles', { name: existing.name, permissions: [], groupAccess: [] })).status).toBe(201);

    const unknownKey = await admin.post('/roles', { name: 'Unknown key', permissions: ['ticket.view', 'nope.nope'], groupAccess: [] });
    expect(unknownKey.status).toBe(400);
    expect(failure(unknownKey).error.details).toEqual([{ path: 'permissions.1', issue: 'invalid_value' }]);

    const twice = await admin.post('/roles', { name: 'Twice', permissions: [], groupAccess: [{ groupId: null, ...NONE }, { groupId: null, ...NONE }] });
    expect(failure(twice).error.details).toEqual([{ path: 'groupAccess.1.groupId', issue: 'invalid_value' }]);

    // Another tenant's group is as unknown as a random id.
    const foreign = await admin.post('/roles', { name: 'Foreign', permissions: [], groupAccess: [{ groupId: foreignGroup.id, ...FULL }] });
    expect(foreign.status).toBe(400);
    expect(failure(foreign).error.details).toEqual([{ path: 'groupAccess.0.groupId', issue: 'invalid_value' }]);

    const tooLong = await admin.post('/roles', { name: 'x'.repeat(61), permissions: [], groupAccess: [] });
    expect(failure(tooLong).error.details).toEqual([{ path: 'name', issue: 'too_long' }]);
  });

  it('POST /roles needs role.create', async () => {
    expect((await asUser(agentA).post('/roles', { name: 'Nope', permissions: [], groupAccess: [] })).status).toBe(403);
  });

  it('GET /roles/{id}: success, 403, cross-tenant 404', async () => {
    const role = await createRole(a, { permissions: ['ticket.view'], groups: [{ group: null, flags: { view: true } }] });
    await createUser(a, { roles: [{ id: role.id }], session: false });
    const response = await asUser(adminA).get(`/roles/${role.id}`);
    expect(response.status).toBe(200);
    expect(body<RoleBody>(response)).toMatchObject({ id: role.id, permissions: ['ticket.view'], groupAccess: [{ groupId: null, ...NONE, view: true }], userCount: 1 });
    expect((await asUser(agentA).get(`/roles/${role.id}`)).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).get(`/roles/${id}`), role.id);
  });

  it('PUT /roles/{id} replaces grants, audits each kind of change and reports groups that lost edit', async () => {
    const support = await createGroup(a);
    const role = await createRole(a, {
      permissions: ['ticket.view', 'ticket.edit'],
      groups: [
        { group: support.id, flags: { view: true, edit: true } },
        { group: null, flags: { view: true, edit: true } },
      ],
    });
    const response = await asUser(adminA).put(`/roles/${role.id}`, {
      name: 'Renamed',
      permissions: ['ticket.view'],
      groupAccess: [{ groupId: support.id, ...NONE, view: true }],
    });
    expect(response.status).toBe(200);
    expect(body<RoleBody>(response)).toMatchObject({ name: 'Renamed', permissions: ['ticket.view'], groupAccess: [{ groupId: support.id, ...NONE, view: true }] });

    const audit = await inspect(a, (tx, repo) => repo.audit(tx, role.id));
    expect(audit.map((row) => row.action)).toEqual(['role.updated', 'permission.changed', 'group_access.changed']);
    const events = await inspect(a, (tx, repo) => repo.events(tx, 'role.updated'));
    const event = events.find((row) => (row.payload as { roleId: string }).roleId === role.id);
    expect(event?.streams).toEqual(['tenant']);
    expect((event?.payload as { groupsLostEdit: (string | null)[] }).groupsLostEdit.sort()).toEqual([support.id, null].sort());
  });

  it('PUT /roles/{id} only audits role.updated when the grants are unchanged', async () => {
    const role = await createRole(a, { permissions: ['ticket.view'] });
    await asUser(adminA).put(`/roles/${role.id}`, { name: role.name, description: 'Just words', permissions: ['ticket.view'], groupAccess: [] });
    expect((await inspect(a, (tx, repo) => repo.audit(tx, role.id))).map((row) => row.action)).toEqual(['role.updated']);
  });

  it('PUT /roles/{id} keeps system role names and never reduces Admin (ADMIN_ACCESS_FIXED)', async () => {
    const admin = asUser(adminA);
    const roles = items<RoleBody>(await admin.get('/roles'));
    const adminRole = roles.find((r) => r.system === 'admin') as RoleBody;
    const agentRole = roles.find((r) => r.system === 'agent') as RoleBody;
    const input = (role: RoleBody) => ({ name: role.name, permissions: role.permissions, groupAccess: role.groupAccess });

    const rename = await admin.put(`/roles/${agentRole.id}`, { ...input(agentRole), name: 'Helpers' });
    expect(rename.status).toBe(409);
    expect(failure(rename).error.code).toBe('SYSTEM_ROLE');
    // Editing a system role's grants is allowed.
    expect((await admin.put(`/roles/${agentRole.id}`, { ...input(agentRole), permissions: [...agentRole.permissions, 'user.view'] })).status).toBe(200);

    for (const reduced of [
      { ...input(adminRole), permissions: adminRole.permissions.filter((key) => key !== 'role.edit') },
      { ...input(adminRole), groupAccess: adminRole.groupAccess.filter((entry) => entry.groupId !== null) },
      { ...input(adminRole), groupAccess: adminRole.groupAccess.map((entry) => ({ ...entry, delete: false })) },
    ]) {
      const response = await admin.put(`/roles/${adminRole.id}`, reduced);
      expect(response.status).toBe(400);
      expect(failure(response).error.code).toBe('ADMIN_ACCESS_FIXED');
    }
    expect((await admin.put(`/roles/${adminRole.id}`, input(adminRole))).status).toBe(200);
  });

  it('PUT /roles/{id}: 403 and cross-tenant 404', async () => {
    const role = await createRole(a);
    const input = { name: 'Other', permissions: [], groupAccess: [] };
    expect((await asUser(agentA).put(`/roles/${role.id}`, input)).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).put(`/roles/${id}`, input), role.id);
  });

  it('DELETE /roles/{id} deletes unused custom roles only', async () => {
    const admin = asUser(adminA);
    const unused = await createRole(a);
    const held = await createRole(a);
    await createUser(a, { roles: [{ id: held.id }], session: false });

    const system = await admin.delete(`/roles/${a.roles.agent}`);
    expect(system.status).toBe(409);
    expect(failure(system).error.code).toBe('SYSTEM_ROLE');
    const inUse = await admin.delete(`/roles/${held.id}`);
    expect(inUse.status).toBe(409);
    expect(failure(inUse).error.code).toBe('ROLE_IN_USE');

    expect((await asUser(agentA).delete(`/roles/${unused.id}`)).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).delete(`/roles/${id}`), unused.id);
    expect((await admin.delete(`/roles/${unused.id}`)).status).toBe(204);
    expect((await admin.get(`/roles/${unused.id}`)).status).toBe(404);
    expect((await inspect(a, (tx, repo) => repo.audit(tx, unused.id))).map((row) => row.action)).toEqual(['role.deleted']);
  });
});

describe('groups', () => {
  it('GET /groups lists by name with a status filter and ticket counts, never another tenant’s', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'] });
    const zeta = await createGroup(tenant, { name: 'Zeta' });
    const alpha = await createGroup(tenant, { name: 'Alpha', status: 'inactive' });
    const foreign = await createGroup(b);
    stats.openByGroup.set(zeta.id, 3);

    const all = await asUser(admin).get('/groups');
    expect(all.status).toBe(200);
    expect(items<GroupBody>(all).map((g) => [g.name, g.status, g.openTicketCount])).toEqual([
      ['Alpha', 'inactive', 0],
      ['Zeta', 'active', 3],
    ]);
    expect(items<GroupBody>(await asUser(admin).get('/groups?status=inactive')).map((g) => g.id)).toEqual([alpha.id]);
    expect(JSON.stringify(all.body)).not.toContain(foreign.id);
    expect((await asUser(admin).get('/groups?status=archived')).status).toBe(400);
    expect((await asUser(agentA).get('/groups')).status).toBe(403);
  });

  it('POST /groups gives only Admin access (FR-029), bumps the access version and audits', async () => {
    const before = await inspect(a, (tx, repo) => repo.accessVersion(tx));
    const response = await asUser(adminA).post('/groups', { name: 'Escalations', description: 'Hard cases' });
    expect(response.status).toBe(201);
    const group = body<GroupBody>(response);
    expect(group).toMatchObject({ name: 'Escalations', description: 'Hard cases', status: 'active', openTicketCount: 0 });

    const access = await inspect(a, (tx, repo) => repo.groupAccess(tx, group.id));
    expect(access).toEqual([{ role_id: a.roles.admin, can_view: true, can_create: true, can_edit: true, can_delete: true }]);
    expect(BigInt(await inspect(a, (tx, repo) => repo.accessVersion(tx)))).toBeGreaterThan(BigInt(before));
    expect((await inspect(a, (tx, repo) => repo.audit(tx, group.id))).map((row) => row.action)).toEqual(['group.created']);

    // The new group shows up in the Admin role's matrix only.
    const roles = items<RoleBody>(await asUser(adminA).get('/roles'));
    expect(roles.filter((role) => role.groupAccess.some((entry) => entry.groupId === group.id)).map((role) => role.system)).toEqual(['admin']);
  });

  it('POST /groups: 409 GROUP_NAME_TAKEN (case-insensitive), 400 invalid, 403 without group.create', async () => {
    await createGroup(a, { name: 'Returns' });
    const taken = await asUser(adminA).post('/groups', { name: 'returns' });
    expect(taken.status).toBe(409);
    expect(failure(taken).error.code).toBe('GROUP_NAME_TAKEN');
    expect((await asUser(adminB).post('/groups', { name: 'Returns' })).status).toBe(201);
    expect(failure(await asUser(adminA).post('/groups', { name: '' })).error.details).toEqual([{ path: 'name', issue: 'too_short' }]);
    expect((await asUser(agentA).post('/groups', { name: 'Nope' })).status).toBe(403);
  });

  it('GET /groups/{id}: success, 403, cross-tenant 404', async () => {
    const group = await createGroup(a);
    const response = await asUser(adminA).get(`/groups/${group.id}`);
    expect(response.status).toBe(200);
    expect(body<GroupBody>(response)).toMatchObject({ id: group.id, name: group.name, status: 'active' });
    expect((await asUser(agentA).get(`/groups/${group.id}`)).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).get(`/groups/${id}`), group.id);
  });

  it('PATCH /groups/{id} renames, deactivates and clears the description; audits the changes only', async () => {
    const group = await createGroup(a);
    const admin = asUser(adminA);
    const response = await admin.patch(`/groups/${group.id}`, { name: 'Tier 2', description: 'Second line', status: 'inactive' });
    expect(response.status).toBe(200);
    expect(body<GroupBody>(response)).toMatchObject({ name: 'Tier 2', description: 'Second line', status: 'inactive' });
    const cleared = body<GroupBody>(await admin.patch(`/groups/${group.id}`, { description: '' }));
    expect(cleared.description).toBeUndefined();
    await admin.patch(`/groups/${group.id}`, { name: 'Tier 2' });

    // The factory writes no audit rows; the unchanged rename adds none either.
    const audit = await inspect(a, (tx, repo) => repo.audit(tx, group.id));
    expect(audit).toEqual([
      { action: 'group.updated', details: { name: 'Tier 2', description: 'Second line', status: 'inactive' } },
      { action: 'group.updated', details: { description: null } },
    ]);
  });

  it('PATCH /groups/{id}: 409 on a taken name, 403, cross-tenant 404', async () => {
    const taken = await createGroup(a, { name: 'Taken name' });
    const group = await createGroup(a);
    const conflict = await asUser(adminA).patch(`/groups/${group.id}`, { name: 'TAKEN NAME' });
    expect(conflict.status).toBe(409);
    expect(failure(conflict).error.code).toBe('GROUP_NAME_TAKEN');
    expect(taken.id).not.toBe(group.id);
    expect((await asUser(agentA).patch(`/groups/${group.id}`, { name: 'x' })).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).patch(`/groups/${id}`, { name: 'x' }), group.id);
  });

  it('DELETE /groups/{id} is refused while tickets reference it (FR-030), then removes its access rows', async () => {
    const group = await createGroup(a, { access: [{ role: 'agent', flags: { view: true } }] });
    stats.hasTickets = true;
    const refused = await asUser(adminA).delete(`/groups/${group.id}`);
    expect(refused.status).toBe(409);
    expect(failure(refused).error.code).toBe('GROUP_HAS_TICKETS');

    stats.hasTickets = false;
    expect((await asUser(agentA).delete(`/groups/${group.id}`)).status).toBe(403);
    await expectCrossTenant404((id) => asUser(adminB).delete(`/groups/${id}`), group.id);
    expect((await asUser(adminA).delete(`/groups/${group.id}`)).status).toBe(204);
    expect(await inspect(a, (tx, repo) => repo.groupAccess(tx, group.id))).toEqual([]);
    expect((await asUser(adminA).get(`/groups/${group.id}`)).status).toBe(404);
  });

  it('GET /groups/{id}/eligible-owners lists active staff with edit on the group', async () => {
    const tenant = await createTenant();
    const admin = await createUser(tenant, { roles: ['admin'], name: 'Ada Admin' });
    const editor = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit'] });
    const viewer = await createRole(tenant, { permissions: ['ticket.view', 'ticket.edit'] });
    const group = await createGroup(tenant, {
      access: [
        { role: { id: editor.id }, flags: { view: true, edit: true } },
        { role: { id: viewer.id }, flags: { view: true } },
      ],
    });
    const owner = await createUser(tenant, { roles: [{ id: editor.id }], name: 'Bob Editor' });
    const onlyViews = await createUser(tenant, { roles: [{ id: viewer.id }], name: 'Cy Viewer' });
    await createUser(tenant, { roles: [{ id: editor.id }], name: 'Dee Deactivated', status: 'deactivated', session: false });
    const outsider = await createUser(tenant, { roles: ['agent'] });
    stats.openByOwner.set(owner.id, 2);

    const response = await asUser(owner).get(`/groups/${group.id}/eligible-owners`);
    expect(response.status).toBe(200);
    expect(items<{ name: string; availability: string; openTicketCount: number; avatarUrl: null }>(response)).toEqual([
      { id: admin.id, name: 'Ada Admin', avatarUrl: null, availability: 'offline', openTicketCount: 0 },
      { id: owner.id, name: 'Bob Editor', avatarUrl: null, availability: 'offline', openTicketCount: 2 },
    ]);

    // View without edit: 403; no view at all: the same 404 as an unknown group.
    expect((await asUser(onlyViews).get(`/groups/${group.id}/eligible-owners`)).status).toBe(403);
    const hidden = await asUser(outsider).get(`/groups/${group.id}/eligible-owners`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual((await asUser(outsider).get(`/groups/${UNKNOWN_ID}/eligible-owners`)).body);
    await expectCrossTenant404((id) => asUser(adminB).get(`/groups/${id}/eligible-owners`), group.id);
  });
});

describe('registry growth (SC-014)', () => {
  it('a permission added to the registry is granted to Admin only, in every tenant', async () => {
    const registry = await service(PermissionRegistry);
    const current = registry.all();
    const byModule = new Map<string, ModulePermissions['resources'][number][]>();
    for (const definition of current) {
      const resources = byModule.get(definition.module) ?? [];
      let resource = resources.find((r) => r.resource === definition.resource);
      if (resource === undefined) {
        resource = { resource: definition.resource, actions: [] };
        resources.push(resource);
      }
      (resource.actions as { action: string; description: string }[]).push({ action: definition.action, description: definition.description });
      byModule.set(definition.module, resources);
    }
    const existing = [...byModule].map(([module, resources]) => definePermissions({ module, resources }));
    const probe = definePermissions({
      module: 'sc_probe',
      resources: [{ resource: 'sc_probe', actions: [{ action: 'view', description: 'Probe permission for SC-014' }] }],
    });

    registry.load([...existing, probe]);
    try {
      await registry.sync();
      const listed = items<{ key: string }>(await asUser(adminA).get('/permissions')).map((p) => p.key);
      expect(listed).toContain('sc_probe.view');

      for (const tenant of [a, b]) {
        const roles = items<RoleBody>(await asUser(tenant === a ? adminA : adminB).get('/roles'));
        for (const role of roles) {
          expect(role.permissions.includes('sc_probe.view'), `${role.name} in ${tenant.slug}`).toBe(role.system === 'admin');
        }
      }
    } finally {
      registry.load(existing);
    }
  });
});
