import { useInfiniteQuery } from '@tanstack/react-query';

import { listAuditLogs } from '../api/generated/operations/operations';

import { mapError } from './errors';

import type { AuditLog } from '../api/generated/model';

/**
 * Audit log (FR-005 audit trail): a cursor-paginated, filterable list for the audit page. Filters
 * are typed values only (never a raw query string); `from`/`to` are ISO timestamps.
 */

export interface AuditLogFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
}

export const auditKeys = {
  all: ['audit-logs'] as const,
  list: (filters: AuditLogFilters) => [...auditKeys.all, 'list', filters] as const,
};

export function useAuditLogs(filters: AuditLogFilters) {
  const query = useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam, signal }) => listAuditLogs({ ...filters, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export type { AuditLog };
