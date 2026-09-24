import { QueryClient } from '@tanstack/react-query';

import { isPermanentFailure } from './errors';

/**
 * The TanStack Query client (research D21). Server state lives here; real-time events patch or
 * invalidate it through `socket.ts`, so lists refetch rarely.
 */

const MAX_RETRIES = 2;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && !isPermanentFailure(error);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Socket events keep data fresh; avoid refetch storms on focus and mount.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Mutations are not idempotent in general; callers opt in (e.g. with clientMessageId).
        retry: false,
      },
    },
  });
}
