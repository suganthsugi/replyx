import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  useDeleteView as useDeleteViewMutation,
  useGetViewCounts,
  useReorderViews as useReorderViewsMutation,
} from '../api/generated/tickets/tickets';

import { mapError } from './errors';
import { viewKeys } from './views';

import type { RealtimeClient } from './socket';
import type { GetViewCounts200, ReorderViewsBody, View } from '../api/generated/model';

/**
 * View counts (FR-073, FR-077) and the view-rail mutations that reorder, hide or delete a view.
 * Components never import `api/generated/tickets` directly (data-hooks rule 6).
 *
 * `useViewCountEvents` is the one place that registers the `views` stream
 * (`client.registerStreamKeys('views', ...)`): a `views.counts_changed` hint (already debounced
 * 500 ms server-side) only refetches `/views/counts`. The view list itself
 * (`viewKeys`, `views.ts`) changes through this session's own mutations below, another session's
 * edit surfacing via `access.changed` (`access.ts`), or a manual refresh — never through the
 * `views` stream, so mount this alongside `useTicketListEvents` instead of the old
 * list-invalidating handler.
 */

export const viewCountKeys = {
  all: ['view-counts'] as const,
};

/**
 * A backstop refetch: a trailing count hint can be lost if the worker crashes inside its 500 ms
 * window (api/src/views/counts-notifier.ts). Cheap, since the server caches counts for 30 s.
 */
export const VIEW_COUNTS_REFETCH_MS = 60_000;

export function useViewCounts() {
  const query = useGetViewCounts<GetViewCounts200>({ query: { queryKey: viewCountKeys.all, refetchInterval: VIEW_COUNTS_REFETCH_MS } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Refetches `/views/counts` on `views.counts_changed`, and (via `resyncRequired`) after a reconnect that missed one. */
export function useViewCountEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    client.registerStreamKeys('views', () => [viewCountKeys.all]);
    return client.onEvent('views.counts_changed', (_envelope, queryClient) => {
      void queryClient.invalidateQueries({ queryKey: viewCountKeys.all });
    });
  }, [client]);
}

type CachedViewList = { items: View[] };

/**
 * Reorders and/or hides views (FR-073): patches the cached `useViews()` list immediately (so the
 * rail reflects the drag before the server answers), rolling back on error, then invalidates on
 * settle so `position`/`hidden` match the server exactly (partial applies, concurrent edits).
 */
export function useReorderViews() {
  const queryClient = useQueryClient();
  const mutation = useReorderViewsMutation({
    mutation: {
      onMutate: async ({ data }: { data: ReorderViewsBody }) => {
        await queryClient.cancelQueries({ queryKey: viewKeys.list() });
        const previous = queryClient.getQueryData<CachedViewList>(viewKeys.list());
        if (previous !== undefined) {
          const changes = new Map(data.items.map((item) => [item.id, item]));
          const items = previous.items
            .map((view) => {
              const change = changes.get(view.id);
              return change === undefined ? view : { ...view, position: change.position, hidden: change.hidden };
            })
            .sort((a, b) => a.position - b.position);
          queryClient.setQueryData<CachedViewList>(viewKeys.list(), { ...previous, items });
        }
        return { previous };
      },
      onError: (_error, _data, context) => {
        if (context?.previous !== undefined) queryClient.setQueryData(viewKeys.list(), context.previous);
      },
      onSettled: () => void queryClient.invalidateQueries({ queryKey: viewKeys.all }),
    },
  });
  return { ...mutation, mutateAsync: (data: ReorderViewsBody) => mutation.mutateAsync({ data }) };
}

/** A default (system) view can only be hidden (`useReorderViews`); the server answers 409 SYSTEM_VIEW for a delete. */
export function useDeleteView() {
  const queryClient = useQueryClient();
  const mutation = useDeleteViewMutation({
    mutation: {
      onSuccess: (_data, { id }) => {
        queryClient.removeQueries({ queryKey: viewKeys.detail(id) });
        void queryClient.invalidateQueries({ queryKey: viewKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: ({ id }: { id: string }) => mutation.mutateAsync({ id }) };
}

export type { GetViewCounts200 };
