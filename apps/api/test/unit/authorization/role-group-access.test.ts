import { describe, expect, it } from 'vitest';

import { decide, type EffectiveAccess, type GroupFlags } from '../../../src/authorization/policy.service.js';
import {
  diffGroupAccess,
  FULL_ACCESS,
  newGroupAccess,
  reducesAccess,
  type GroupAccessEntry,
} from '../../../src/authorization/role-access.js';

const USER = '0192f3c4-0000-7000-8000-0000000000a1';
const SUPPORT = '0192f3c4-0000-7000-8000-0000000000b1';
const BILLING = '0192f3c4-0000-7000-8000-0000000000b2';
const NEW_GROUP = '0192f3c4-0000-7000-8000-0000000000b3';
const ADMIN_ROLE = '0192f3c4-0000-7000-8000-0000000000c1';
const AGENT_ROLE = '0192f3c4-0000-7000-8000-0000000000c2';
const CUSTOM_ROLE = '0192f3c4-0000-7000-8000-0000000000c3';

const NONE: GroupFlags = { view: false, create: false, edit: false, delete: false };
const entry = (groupId: string | null, flags: Partial<GroupFlags>): GroupAccessEntry => ({ groupId, ...NONE, ...flags });

interface RoleGrants {
  permissions: string[];
  groupAccess: GroupAccessEntry[];
}

/** A user's effective access over several roles, merged like `AccessRepository.load` (set union, per-group OR). */
function effective(...roles: RoleGrants[]): EffectiveAccess {
  const groups = new Map<string | null, GroupFlags>();
  for (const role of roles) {
    for (const { groupId, ...flags } of role.groupAccess) {
      const prev = groups.get(groupId) ?? NONE;
      groups.set(groupId, {
        view: prev.view || flags.view,
        create: prev.create || flags.create,
        edit: prev.edit || flags.edit,
        delete: prev.delete || flags.delete,
      });
    }
  }
  for (const [groupId, flags] of groups) if (!Object.values(flags).some(Boolean)) groups.delete(groupId);
  return { userId: USER, accessVersion: '1', permissions: new Set(roles.flatMap((r) => r.permissions)), groups };
}

const ticket = (groupId: string | null) => ({ type: 'ticket' as const, groupId });

describe('union of flags across roles (FR-021)', () => {
  const viewer: RoleGrants = { permissions: ['ticket.view'], groupAccess: [entry(SUPPORT, { view: true })] };
  const editor: RoleGrants = { permissions: ['ticket.view', 'ticket.edit'], groupAccess: [entry(SUPPORT, { edit: true })] };

  it('grants an action only one of the roles gives', () => {
    expect(decide(effective(viewer), 'ticket.edit', ticket(SUPPORT))).toBe('deny');
    expect(decide(effective(viewer, editor), 'ticket.edit', ticket(SUPPORT))).toBe('allow');
  });

  it('needs view from some role before any other flag counts', () => {
    // Edit without view anywhere keeps the group invisible (constitution I: not_found, not deny).
    expect(decide(effective(editor), 'ticket.edit', ticket(SUPPORT))).toBe('not_found');
  });

  it('keeps groups separate: flags on one group never leak to another', () => {
    expect(decide(effective(viewer, editor), 'ticket.view', ticket(BILLING))).toBe('not_found');
  });
});

describe('Ungrouped entry', () => {
  it('is its own row in the matrix, independent of every group', () => {
    const ungroupedOnly: RoleGrants = { permissions: ['ticket.view', 'ticket.edit'], groupAccess: [entry(null, { view: true, edit: true })] };
    expect(decide(effective(ungroupedOnly), 'ticket.edit', ticket(null))).toBe('allow');
    expect(decide(effective(ungroupedOnly), 'ticket.view', ticket(SUPPORT))).toBe('not_found');
  });

  it('is diffed like a group: losing edit on Ungrouped reports null', () => {
    const { changed, lostEdit } = diffGroupAccess(
      [entry(null, { view: true, edit: true }), entry(SUPPORT, { view: true, edit: true })],
      [entry(null, { view: true }), entry(SUPPORT, { view: true, edit: true })],
    );
    expect(changed).toBe(true);
    expect(lostEdit).toEqual([null]);
  });
});

describe('diffGroupAccess (FR-026)', () => {
  it('reports no change for the same matrix in another order', () => {
    const a = [entry(SUPPORT, { view: true, edit: true }), entry(BILLING, { view: true })];
    expect(diffGroupAccess(a, [...a].reverse())).toEqual({ changed: false, lostEdit: [] });
  });

  it('treats a missing entry as no access', () => {
    expect(diffGroupAccess([entry(SUPPORT, { view: true, edit: true })], [])).toEqual({ changed: true, lostEdit: [SUPPORT] });
    expect(diffGroupAccess([entry(SUPPORT, NONE)], [])).toEqual({ changed: false, lostEdit: [] });
  });

  it('lists only the groups that lost edit, not those that gained or lost other flags', () => {
    const { changed, lostEdit } = diffGroupAccess(
      [entry(SUPPORT, { view: true, edit: true }), entry(BILLING, { view: true, delete: true })],
      [entry(SUPPORT, { view: true }), entry(BILLING, { view: true, edit: true })],
    );
    expect(changed).toBe(true);
    expect(lostEdit).toEqual([SUPPORT]);
  });
});

describe('Admin locked (FR-019)', () => {
  const admin: RoleGrants = {
    permissions: ['role.edit', 'ticket.view'],
    groupAccess: [entry(null, FULL_ACCESS), entry(SUPPORT, FULL_ACCESS)],
  };

  it('accepts the same grants and additions', () => {
    expect(reducesAccess(admin, admin)).toBe(false);
    expect(reducesAccess(admin, { ...admin, permissions: [...admin.permissions, 'group.create'] })).toBe(false);
    expect(reducesAccess(admin, { ...admin, groupAccess: [...admin.groupAccess, entry(BILLING, FULL_ACCESS)] })).toBe(false);
  });

  it('refuses a removed permission', () => {
    expect(reducesAccess(admin, { ...admin, permissions: ['ticket.view'] })).toBe(true);
  });

  it('refuses any flag taken away, and a dropped group or Ungrouped entry', () => {
    expect(reducesAccess(admin, { ...admin, groupAccess: [entry(null, FULL_ACCESS), entry(SUPPORT, { ...FULL_ACCESS, delete: false })] })).toBe(
      true,
    );
    expect(reducesAccess(admin, { ...admin, groupAccess: [entry(SUPPORT, FULL_ACCESS)] })).toBe(true);
    expect(reducesAccess(admin, { ...admin, groupAccess: [entry(null, FULL_ACCESS)] })).toBe(true);
  });
});

describe('new group (FR-029)', () => {
  const roles = [
    { id: ADMIN_ROLE, system_key: 'admin' as const },
    { id: AGENT_ROLE, system_key: 'agent' as const },
    { id: CUSTOM_ROLE, system_key: null },
  ];

  it('starts with full access for Admin and no row for any other role', () => {
    expect(newGroupAccess(roles, NEW_GROUP)).toEqual([{ roleId: ADMIN_ROLE, groupId: NEW_GROUP, ...FULL_ACCESS }]);
  });

  it('is visible only to Admin until access is granted to other roles', () => {
    const rows = newGroupAccess(roles, NEW_GROUP);
    const grantsOf = (roleId: string, permissions: string[]): RoleGrants => ({
      permissions,
      groupAccess: rows.filter((row) => row.roleId === roleId),
    });
    const ticketKeys = ['ticket.view', 'ticket.create', 'ticket.edit', 'ticket.delete'];
    expect(decide(effective(grantsOf(ADMIN_ROLE, ticketKeys)), 'ticket.delete', ticket(NEW_GROUP))).toBe('allow');
    expect(decide(effective(grantsOf(AGENT_ROLE, ticketKeys)), 'ticket.view', ticket(NEW_GROUP))).toBe('not_found');
    expect(decide(effective(grantsOf(CUSTOM_ROLE, ticketKeys)), 'ticket.view', ticket(NEW_GROUP))).toBe('not_found');
  });
});
