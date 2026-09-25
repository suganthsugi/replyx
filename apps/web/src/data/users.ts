import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { useListRoles } from '../api/generated/access/access';
import {
  listUsers,
  useDeactivateUser as useDeactivateUserMutation,
  useDeleteUser as useDeleteUserMutation,
  useEraseUser as useEraseUserMutation,
  useInviteUser as useInviteUserMutation,
  useReactivateUser as useReactivateUserMutation,
  useUpdateUser as useUpdateUserMutation,
} from '../api/generated/identity/identity';

import { mapError } from './errors';

import type { ListUsersKind, Role, User, UserStatus } from '../api/generated/model';

/**
 * User directory and role hooks (data-hooks rule 6): components never import
 * `api/generated/identity` directly. Mutations invalidate `userKeys.all` so the list and any open
 * detail refetch.
 */

export interface UserFilters {
  kind?: ListUsersKind;
  status?: UserStatus;
  roleId?: string;
  q?: string;
}

export const userKeys = {
  all: ['users'] as const,
  list: (filters: UserFilters) => [...userKeys.all, 'list', filters] as const,
};

export function useUsers(filters: UserFilters) {
  const query = useInfiniteQuery({
    queryKey: userKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listUsers({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useInviteUser() {
  const queryClient = useQueryClient();
  const mutation = useInviteUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { email: string; name?: string; roleIds: string[] }) => mutation.mutateAsync({ data }),
  };
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  const mutation = useUpdateUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: ({ id, ...data }: { id: string; name?: string; roleIds?: string[] }) =>
      mutation.mutateAsync({ id, data }),
  };
}

export function useDeactivateUser() {
  const queryClient = useQueryClient();
  const mutation = useDeactivateUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export function useReactivateUser() {
  const queryClient = useQueryClient();
  const mutation = useReactivateUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  const mutation = useDeleteUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export function useEraseUser() {
  const queryClient = useQueryClient();
  const mutation = useEraseUserMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: userKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id, data: { confirm: 'ERASE' } }),
  };
}

export const roleKeys = {
  all: ['roles'] as const,
};

export function useRoles() {
  const query = useListRoles<{ items: Role[] }>({
    query: { queryKey: roleKeys.all },
  });
  return {
    ...query,
    data: query.data?.items,
    error: query.error ? mapError(query.error) : undefined,
  };
}

export type { User };
