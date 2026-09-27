import { useGetView, useListViews } from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { View } from '../api/generated/model';

/**
 * Saved views (FR-070–FR-077): the sidebar list with live counts and a single view's definition.
 * Components never import `api/generated/tickets` directly (data-hooks rule 6).
 */

export const viewKeys = {
  all: ['views'] as const,
  list: () => [...viewKeys.all, 'list'] as const,
  detail: (id: string) => [...viewKeys.all, 'detail', id] as const,
};

export function useViews() {
  const query = useListViews<{ items: View[] }>({ query: { queryKey: viewKeys.list() } });
  return { ...query, data: query.data?.items, error: query.error ? mapError(query.error) : undefined };
}

export function useView(id: string | undefined) {
  const query = useGetView<View>(id ?? '', { query: { queryKey: viewKeys.detail(id ?? ''), enabled: id !== undefined } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

// Real time: `useViewCountEvents` (data/view-counts.ts) owns the `views` stream registration and
// the `views.counts_changed` handler, since that hint only ever refetches counts, not this list.

export type { View };
