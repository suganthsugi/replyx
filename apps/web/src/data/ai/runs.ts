import { useInfiniteQuery } from '@tanstack/react-query';

import { listAiRuns } from '../../api/generated/ai/ai';
import { mapError } from '../errors';

import type { AiPurpose, AiRun, ListAiRuns200 } from '../../api/generated/model';

/** The AI run log (specs/002-ai-assist US3): cursor pages, totals taken from the first page. */

export interface AiRunsFilter {
  from?: string;
  to?: string;
  purpose?: AiPurpose;
}

export const aiRunKeys = {
  all: ['ai-runs'] as const,
  list: (filter: AiRunsFilter) => [...aiRunKeys.all, 'list', filter] as const,
};

const PAGE_SIZE = 50;

export function useAiRuns(filter: AiRunsFilter = {}, enabled = true) {
  const query = useInfiniteQuery<ListAiRuns200, Error, { pages: ListAiRuns200[] }, ReturnType<typeof aiRunKeys.list>, string | undefined>({
    queryKey: aiRunKeys.list(filter),
    queryFn: ({ pageParam, signal }) =>
      listAiRuns(
        {
          limit: PAGE_SIZE,
          ...(filter.from === undefined ? {} : { from: filter.from }),
          ...(filter.to === undefined ? {} : { to: filter.to }),
          ...(filter.purpose === undefined ? {} : { purpose: filter.purpose }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        { signal },
      ),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
  const pages = query.data?.pages ?? [];
  const items: AiRun[] = pages.flatMap((page) => page.items);
  const last = pages[pages.length - 1];
  return {
    items,
    nextCursor: last?.nextCursor ?? null,
    totals: pages[0]?.totals,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error ? mapError(query.error) : undefined,
    refetch: query.refetch,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

export type { AiRun };
