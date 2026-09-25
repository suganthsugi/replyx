import { useQueryClient } from '@tanstack/react-query';

import {
  useCreateGroup as useCreateGroupMutation,
  useDeleteGroup as useDeleteGroupMutation,
  useListEligibleOwners,
  useListGroups,
  useUpdateGroup as useUpdateGroupMutation,
} from '../api/generated/access/access';

import { mapError } from './errors';
import { roleKeys } from './roles';

import type { EligibleOwner, Group, GroupCreateInput, GroupInput, ListGroupsStatus } from '../api/generated/model';

/**
 * Groups (FR-028–FR-030) and the owner picker's eligible owners (FR-040). Creating or deleting a
 * group changes the Admin role's matrix, so those also refetch roles.
 */

export const groupKeys = {
  all: ['groups'] as const,
  list: (status?: ListGroupsStatus) => [...groupKeys.all, 'list', status ?? 'all'] as const,
  eligibleOwners: (id: string) => [...groupKeys.all, 'eligible-owners', id] as const,
};

export function useGroups(status?: ListGroupsStatus) {
  const params = status === undefined ? undefined : { status };
  const query = useListGroups<{ items: Group[] }>(params, { query: { queryKey: groupKeys.list(status) } });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

export function useEligibleOwners(groupId: string | undefined) {
  const query = useListEligibleOwners<{ items: EligibleOwner[] }>(groupId ?? '', {
    query: { queryKey: groupKeys.eligibleOwners(groupId ?? ''), enabled: groupId !== undefined },
  });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidate(withRoles: boolean) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: groupKeys.all });
    if (withRoles) void queryClient.invalidateQueries({ queryKey: roleKeys.all });
  };
}

export function useCreateGroup() {
  const invalidate = useInvalidate(true);
  const mutation = useCreateGroupMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: (data: GroupCreateInput) => mutation.mutateAsync({ data }) };
}

export function useUpdateGroup() {
  const invalidate = useInvalidate(false);
  const mutation = useUpdateGroupMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: ({ id, ...data }: GroupInput & { id: string }) => mutation.mutateAsync({ id, data }) };
}

export function useDeleteGroup() {
  const invalidate = useInvalidate(true);
  const mutation = useDeleteGroupMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export type { EligibleOwner, Group };
