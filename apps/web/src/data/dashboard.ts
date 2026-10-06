import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getDashboard } from '../api/generated/operations/operations';

import { mapError } from './errors';
import { useRealtime } from './realtime';

import type { Dashboard } from '../api/generated/model';

/**
 * The workspace dashboard (FR-086, "live counts"). Freshness: realtime hints invalidate the query
 * (`views.counts_changed`, which the server debounces and which fires on every ticket change that
 * moves a count, plus `sla.breached` and `ticket.created`), throttled so a burst refetches once;
 * `view-counts.ts` lists `dashboardKeys` for `views` resync. A 60 s `refetchInterval` is the fallback for a lost hint (same backstop as view counts).
 */

export const dashboardKeys = {
  all: ['dashboard'] as const,
};

export const DASHBOARD_REFETCH_MS = 60_000;
/** At most one hint-driven refetch per this window. */
export const DASHBOARD_HINT_THROTTLE_MS = 2_000;

const HINT_TYPES = ['views.counts_changed', 'sla.breached', 'ticket.created'] as const;

export function useDashboard() {
  const client = useRealtime();

  useEffect(() => {
    if (!client) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onHint = (_envelope: unknown, queryClient: QueryClient) => {
      if (timer !== undefined) return;
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      timer = setTimeout(() => {
        timer = undefined;
      }, DASHBOARD_HINT_THROTTLE_MS);
    };
    const off = HINT_TYPES.map((type) => client.onEvent(type, onHint));
    return () => {
      off.forEach((unsubscribe) => unsubscribe());
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client]);

  const query = useQuery<Dashboard>({
    queryKey: dashboardKeys.all,
    queryFn: ({ signal }) => getDashboard({ signal }),
    refetchInterval: DASHBOARD_REFETCH_MS,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export type { Dashboard };
