import { useQueryClient } from '@tanstack/react-query';

import { useGetCustomer, useUpdateCustomer as useUpdateCustomerMutation } from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { CustomerProfile, UpdateCustomerBody } from '../api/generated/model';

/**
 * A customer's profile (FR-069): contact details, tags and their open/closed tickets, limited to
 * what the caller has access to. Components never import `api/generated/tickets` directly
 * (data-hooks rule 6).
 */

export const customerKeys = {
  all: ['customers'] as const,
  detail: (id: string) => [...customerKeys.all, 'detail', id] as const,
};

export function useCustomer(id: string | undefined) {
  const query = useGetCustomer<CustomerProfile>(id ?? '', { query: { queryKey: customerKeys.detail(id ?? ''), enabled: id !== undefined } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Edit contact details and tags. */
export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  const mutation = useUpdateCustomerMutation({
    mutation: { onSuccess: (customer) => queryClient.setQueryData(customerKeys.detail(customer.id), customer) },
  });
  return { ...mutation, mutateAsync: ({ id, ...data }: { id: string } & UpdateCustomerBody) => mutation.mutateAsync({ id, data }) };
}

export type { CustomerProfile };
