import { useQueryClient } from '@tanstack/react-query';

import {
  useCreateSupportAccessGrant as useCreateSupportAccessGrantMutation,
  useListSupportAccessGrants,
  useRevokeSupportAccessGrant as useRevokeSupportAccessGrantMutation,
} from '../api/generated/operations/operations';

import { mapError } from './errors';

/** The tenant admin's view of platform support access (FR-001a), for `SupportAccessPage`. */

export const supportAccessKeys = {
  all: ['support-access'] as const,
};

export function useSupportAccessGrants() {
  const query = useListSupportAccessGrants({ query: { queryKey: supportAccessKeys.all } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useGrantSupportAccess() {
  const queryClient = useQueryClient();
  const mutation = useCreateSupportAccessGrantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: supportAccessKeys.all });
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { durationHours: number; reason?: string }) => mutation.mutateAsync({ data }),
  };
}

export function useRevokeSupportAccess() {
  const queryClient = useQueryClient();
  const mutation = useRevokeSupportAccessGrantMutation({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: supportAccessKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (input: { id: string }) => mutation.mutateAsync({ id: input.id }) };
}
