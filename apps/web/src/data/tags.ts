import { useQueryClient } from '@tanstack/react-query';

import {
  useCreateTag as useCreateTagMutation,
  useDeleteTag as useDeleteTagMutation,
  useListTags,
  useUpdateTag as useUpdateTagMutation,
} from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { CreateTagBody, ListTagsParams, TagRef, UpdateTagBody } from '../api/generated/model';

/**
 * Tenant tags (tag.view/create/edit/delete): used both for the tag picker (search) on tickets and
 * customers, and for a tags admin page. Components never import `api/generated/tickets` directly
 * (data-hooks rule 6).
 */

export const tagKeys = {
  all: ['tags'] as const,
  search: (q?: string) => [...tagKeys.all, 'search', q ?? ''] as const,
};

/** All tags, or a substring search (`q`) for the tag picker's autocomplete. */
export function useTags(params?: ListTagsParams) {
  const query = useListTags<{ items: TagRef[] }>(params, { query: { queryKey: tagKeys.search(params?.q) } });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: tagKeys.all });
}

export function useCreateTag() {
  const invalidate = useInvalidate();
  const mutation = useCreateTagMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: (data: CreateTagBody) => mutation.mutateAsync({ data }) };
}

export function useUpdateTag() {
  const invalidate = useInvalidate();
  const mutation = useUpdateTagMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: ({ id, ...data }: { id: string } & UpdateTagBody) => mutation.mutateAsync({ id, data }) };
}

export function useDeleteTag() {
  const invalidate = useInvalidate();
  const mutation = useDeleteTagMutation({ mutation: { onSuccess: invalidate } });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export type { TagRef };
