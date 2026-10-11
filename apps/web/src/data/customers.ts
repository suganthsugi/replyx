import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { listCustomerMessages, useGetCustomer, useUpdateCustomer as useUpdateCustomerMutation } from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { CustomerHistoryMessage, CustomerProfile, ListCustomerMessages200, UpdateCustomerBody } from '../api/generated/model';

/**
 * A customer's profile (FR-069): contact details, tags and their open/closed tickets, limited to
 * what the caller has access to. Components never import `api/generated/tickets` directly
 * (data-hooks rule 6). `useCustomerHistory` pages through every message on the customer's tickets
 * the caller can view, newest first (US16).
 */

export const customerKeys = {
  all: ['customers'] as const,
  detail: (id: string) => [...customerKeys.all, 'detail', id] as const,
  history: (id: string) => [...customerKeys.all, 'history', id] as const,
};

const HISTORY_PAGE_SIZE = 30;

export function useCustomer(id: string | undefined) {
  const query = useGetCustomer<CustomerProfile>(id ?? '', { query: { queryKey: customerKeys.detail(id ?? ''), enabled: id !== undefined } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** The customer's full message history on accessible tickets, newest first, loaded page by page. */
export function useCustomerHistory(id: string | undefined) {
  const query = useInfiniteQuery<ListCustomerMessages200, Error, CustomerHistoryMessage[], ReturnType<typeof customerKeys.history>, string | undefined>({
    queryKey: customerKeys.history(id ?? ''),
    queryFn: ({ pageParam, signal }) =>
      listCustomerMessages(id ?? '', { limit: HISTORY_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
    enabled: id !== undefined,
  });
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

export type { CustomerHistoryMessage, CustomerProfile };
