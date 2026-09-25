import type { GroupAction } from './policy.service.js';
import type { SystemRoleKey } from '../platform-kernel/db/tables/authorization.js';

/**
 * Pure rules over a role's permissions and group-access matrix (FR-019, FR-022–FR-026, FR-029),
 * shared by the roles and groups services. `groupId: null` is the built-in Ungrouped entry.
 */

export type GroupAccessFlags = Readonly<Record<GroupAction, boolean>>;

export interface GroupAccessEntry extends GroupAccessFlags {
  groupId: string | null;
}

const ACTIONS: readonly GroupAction[] = ['view', 'create', 'edit', 'delete'];

const NO_ACCESS: GroupAccessFlags = { view: false, create: false, edit: false, delete: false };

export const FULL_ACCESS: GroupAccessFlags = { view: true, create: true, edit: true, delete: true };

function byGroup(entries: readonly GroupAccessEntry[]): Map<string | null, GroupAccessFlags> {
  return new Map(entries.map((entry) => [entry.groupId, entry]));
}

/**
 * What a matrix edit changes: whether any flag differs (a missing entry = no access) and which
 * groups lost `edit`, in first-seen order. Owners on those groups are unassigned (FR-026).
 */
export function diffGroupAccess(
  current: readonly GroupAccessEntry[],
  next: readonly GroupAccessEntry[],
): { changed: boolean; lostEdit: (string | null)[] } {
  const before = byGroup(current);
  const after = byGroup(next);
  let changed = false;
  const lostEdit: (string | null)[] = [];
  for (const groupId of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(groupId) ?? NO_ACCESS;
    const b = after.get(groupId) ?? NO_ACCESS;
    if (ACTIONS.some((action) => a[action] !== b[action])) changed = true;
    if (a.edit && !b.edit) lostEdit.push(groupId);
  }
  return { changed, lostEdit };
}

/**
 * True when `next` takes away anything `current` grants: a permission key or any flag on any
 * group. Admin's access may only grow (FR-019, 400 `ADMIN_ACCESS_FIXED`).
 */
export function reducesAccess(
  current: { permissions: Iterable<string>; groupAccess: readonly GroupAccessEntry[] },
  next: { permissions: Iterable<string>; groupAccess: readonly GroupAccessEntry[] },
): boolean {
  const nextPermissions = new Set(next.permissions);
  for (const key of current.permissions) if (!nextPermissions.has(key)) return true;
  const after = byGroup(next.groupAccess);
  return current.groupAccess.some((entry) => {
    const b = after.get(entry.groupId) ?? NO_ACCESS;
    return ACTIONS.some((action) => entry[action] && !b[action]);
  });
}

/** The access rows a new group starts with: full access for Admin, nothing for anyone else (FR-029). */
export function newGroupAccess(
  roles: readonly { id: string; system_key: SystemRoleKey | null }[],
  groupId: string,
): (GroupAccessEntry & { roleId: string })[] {
  return roles.filter((role) => role.system_key === 'admin').map((role) => ({ roleId: role.id, groupId, ...FULL_ACCESS }));
}
