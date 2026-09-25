import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import {
  useCreateRole as useCreateRoleMutation,
  useDeleteRole as useDeleteRoleMutation,
  useGetRole,
  useListPermissions,
  useListRoles,
  useUpdateRole as useUpdateRoleMutation,
} from '../api/generated/access/access';

import { meKeys } from './auth';
import { mapError } from './errors';

import type { GroupAccessEntry, Permission, Role, RoleInput } from '../api/generated/model';

/**
 * Roles and the permission registry (FR-016–FR-024) for the role pages and the invite dialog
 * (data-hooks rule 6: components never import `api/generated/access`). Role changes can change
 * the signed-in user's own access, so mutations also refetch `/me`; other users learn about it
 * over the socket (`access.changed`, see `access.ts`).
 */

export const roleKeys = {
  all: ['roles'] as const,
  detail: (id: string) => [...roleKeys.all, 'detail', id] as const,
  permissions: ['permissions'] as const,
};

export function useRoles() {
  const query = useListRoles<{ items: Role[] }>({ query: { queryKey: roleKeys.all } });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

export function useRole(id: string | undefined) {
  const query = useGetRole<Role>(id ?? '', { query: { queryKey: roleKeys.detail(id ?? ''), enabled: id !== undefined } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function usePermissions() {
  const query = useListPermissions<{ items: Permission[] }>({
    query: { queryKey: roleKeys.permissions, staleTime: 5 * 60_000 },
  });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidateRoles() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: roleKeys.all });
    void queryClient.invalidateQueries({ queryKey: meKeys.all });
  };
}

export function useCreateRole() {
  const invalidate = useInvalidateRoles();
  const mutation = useCreateRoleMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: (data: RoleInput) => mutation.mutateAsync({ data }) };
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRoles();
  const mutation = useUpdateRoleMutation({
    mutation: {
      onSuccess: (role: Role) => {
        queryClient.setQueryData(roleKeys.detail(role.id), role);
        invalidate();
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id, ...data }: RoleInput & { id: string }) => mutation.mutateAsync({ id, data }) };
}

export function useDeleteRole() {
  const invalidate = useInvalidateRoles();
  const mutation = useDeleteRoleMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

const SEEN_PERMISSIONS_KEY = 'rx:seen-permissions';

/**
 * Registry keys this browser has not seen before (the "New" badge, SC-014). The first visit
 * marks nothing as new; every visit remembers the current keys. Computed once per mount, so a
 * refetch doesn't clear the badges while the page is open.
 */
export function useNewPermissionKeys(permissions: readonly Permission[] | undefined): ReadonlySet<string> {
  const [newKeys, setNewKeys] = useState<ReadonlySet<string>>(() => new Set());
  const done = useRef(false);
  useEffect(() => {
    if (permissions === undefined || done.current) return;
    done.current = true;
    const keys = permissions.map((permission) => permission.key);
    let seen: unknown = null;
    try {
      seen = JSON.parse(localStorage.getItem(SEEN_PERMISSIONS_KEY) ?? 'null');
    } catch {
      seen = null;
    }
    if (Array.isArray(seen)) {
      const known = new Set(seen);
      setNewKeys(new Set(keys.filter((key) => !known.has(key))));
    }
    try {
      localStorage.setItem(SEEN_PERMISSIONS_KEY, JSON.stringify(keys));
    } catch {
      // Private mode or quota: no badges next time.
    }
  }, [permissions]);
  return newKeys;
}

/** Groups (`null` = Ungrouped) where `before` grants edit and `after` does not (FR-026). */
export function groupsLosingEdit(before: readonly GroupAccessEntry[], after: readonly GroupAccessEntry[]): (string | null)[] {
  const next = new Map(after.map((entry) => [entry.groupId, entry]));
  return before.filter((entry) => entry.edit && next.get(entry.groupId)?.edit !== true).map((entry) => entry.groupId);
}

export type { GroupAccessEntry, Permission, Role, RoleInput };
