import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import {
  listTenants,
  useCreateTenant as useCreateTenantMutation,
  useOpenSupportSession as useOpenSupportSessionMutation,
  useOperatorSignIn as useOperatorSignInMutation,
  useOperatorSignOut as useOperatorSignOutMutation,
  useReactivateTenant as useReactivateTenantMutation,
  useSuspendTenant as useSuspendTenantMutation,
  useUpdateTenant as useUpdateTenantMutation,
} from '../api/generated/platform/platform';

import { mapError } from './errors';

import type { CreateTenantBody, ListTenantsStatus, Tenant } from '../api/generated/model';

/**
 * The platform console (data-hooks rule 6): operators sign in on the console host and work with
 * tenants. Every mutation invalidates the tenant list, because suspension and support sessions
 * change what the list shows.
 */

export interface TenantFilters {
  status?: ListTenantsStatus;
  q?: string;
}

export const tenantKeys = {
  all: ['tenants'] as const,
  list: (filters: TenantFilters) => [...tenantKeys.all, 'list', filters] as const,
};

export const operatorKeys = {
  me: ['operator'] as const,
};

export function useTenants(filters: TenantFilters) {
  const query = useInfiniteQuery({
    queryKey: tenantKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listTenants({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useOperatorSignIn() {
  const queryClient = useQueryClient();
  const mutation = useOperatorSignInMutation({
    mutation: {
      onSuccess: (operator) => {
        queryClient.setQueryData(operatorKeys.me, operator);
        // The tenant list is what sent the operator here, and it is sitting on its 401: refetch it.
        void queryClient.invalidateQueries({ queryKey: tenantKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { email: string; password: string }) => mutation.mutateAsync({ data }),
  };
}

export function useOperatorSignOut() {
  const queryClient = useQueryClient();
  const mutation = useOperatorSignOutMutation({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
      },
    },
  });
  return { ...mutation, mutateAsync: () => mutation.mutateAsync(undefined) };
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  const mutation = useCreateTenantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: tenantKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (data: CreateTenantBody) => mutation.mutateAsync({ data }) };
}

export function useRenameTenant() {
  const queryClient = useQueryClient();
  const mutation = useUpdateTenantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: tenantKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (input: { id: string; name: string }) => mutation.mutateAsync({ id: input.id, data: { name: input.name } }) };
}

export function useSuspendTenant() {
  const queryClient = useQueryClient();
  const mutation = useSuspendTenantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: tenantKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (input: { id: string; reason?: string }): Promise<Tenant> =>
      mutation.mutateAsync({ id: input.id, data: input.reason === undefined ? {} : { reason: input.reason } }),
  };
}

export function useReactivateTenant() {
  const queryClient = useQueryClient();
  const mutation = useReactivateTenantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: tenantKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (input: { id: string }): Promise<Tenant> => mutation.mutateAsync({ id: input.id }) };
}

/**
 * Opens a read-only support session. The token is the operator's credential on the tenant host
 * and is shown once, never stored by these hooks.
 */
export function useOpenSupportSession() {
  const mutation = useOpenSupportSessionMutation();
  return { ...mutation, mutateAsync: (input: { id: string }) => mutation.mutateAsync({ id: input.id }) };
}
