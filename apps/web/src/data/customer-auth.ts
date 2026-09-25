import { useQueryClient } from '@tanstack/react-query';

import {
  useCustomerSignIn as useCustomerPasswordSignInMutation,
  useCustomerSignOut as useCustomerSignOutMutation,
  useCustomerSignOutAll as useCustomerSignOutAllMutation,
  useGetCustomerMe,
  useRedeemSignInLink as useRedeemSignInLinkMutation,
  useRequestSignInLink as useRequestSignInLinkMutation,
  useUpdateCustomerMe as useUpdateCustomerMeMutation,
} from '../api/generated/customer/customer';

import { mapError } from './errors';

import type { CustomerMe, UpdateCustomerMeBody } from '../api/generated/model';

/**
 * Customer auth and profile hooks (data-hooks rule 8): only the `customer` tag. Components never
 * import `api/generated/customer` directly.
 */

export const customerMeKeys = {
  all: ['customerMe'] as const,
};

export function useRequestSignInLink() {
  const mutation = useRequestSignInLinkMutation();
  return {
    ...mutation,
    mutateAsync: (data: { email: string; name?: string }) => mutation.mutateAsync({ data }),
  };
}

export function useRedeemSignInLink() {
  const queryClient = useQueryClient();
  const mutation = useRedeemSignInLinkMutation({
    mutation: {
      onSuccess: (me: CustomerMe) => {
        queryClient.setQueryData(customerMeKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { token: string; trustDevice?: boolean }) => mutation.mutateAsync({ data }),
  };
}

export function useCustomerPasswordSignIn() {
  const queryClient = useQueryClient();
  const mutation = useCustomerPasswordSignInMutation({
    mutation: {
      onSuccess: (me: CustomerMe) => {
        queryClient.setQueryData(customerMeKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: { email: string; password: string }) => mutation.mutateAsync({ data }),
  };
}

export function useCustomerMe() {
  const query = useGetCustomerMe({
    query: {
      queryKey: customerMeKeys.all,
      retry: false,
    },
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useUpdateCustomerMe() {
  const queryClient = useQueryClient();
  const mutation = useUpdateCustomerMeMutation({
    mutation: {
      onSuccess: (me: CustomerMe) => {
        queryClient.setQueryData(customerMeKeys.all, me);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: UpdateCustomerMeBody) => mutation.mutateAsync({ data }),
  };
}

export function useCustomerSignOut() {
  const queryClient = useQueryClient();
  const mutation = useCustomerSignOutMutation({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
      },
    },
  });
  return { ...mutation, mutateAsync: () => mutation.mutateAsync(undefined) };
}

export function useCustomerSignOutAll() {
  const queryClient = useQueryClient();
  const mutation = useCustomerSignOutAllMutation({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
      },
    },
  });
  return { ...mutation, mutateAsync: () => mutation.mutateAsync(undefined) };
}
