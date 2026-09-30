import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { listEligibleOwners, useListGroupDestinations, useListRoles } from '../api/generated/access/access';
import {
  previewViewCount,
  useCreateView as useCreateViewMutation,
  useListTags,
  useUpdateView as useUpdateViewMutation,
} from '../api/generated/tickets/tickets';

import { mapError } from './errors';
import { groupKeys } from './groups';
import { roleKeys } from './roles';
import { tagKeys } from './tags';
import { viewCountKeys } from './view-counts';
import { viewKeys } from './views';

import type { ConditionGroup, EligibleOwner, GroupRef, Role, TagRef, View, ViewInput } from '../api/generated/model';

/**
 * View builder data (FR-070–FR-077): create/update mutations, the live count preview, the lookups
 * the builder's pickers need, and the mapping of submit failures onto builder fields. Components
 * never import `api/generated` directly (data-hooks rule 6).
 */

function useOnViewSaved() {
  const queryClient = useQueryClient();
  return (view: View) => {
    queryClient.setQueryData(viewKeys.detail(view.id), view);
    void queryClient.invalidateQueries({ queryKey: viewKeys.list() });
    void queryClient.invalidateQueries({ queryKey: viewCountKeys.all });
  };
}

/** Other viewers' rails follow through `views.counts_changed` (`useViewCountEvents`). */
export function useCreateView() {
  const onSuccess = useOnViewSaved();
  const mutation = useCreateViewMutation({ mutation: { onSuccess } });
  return { ...mutation, mutateAsync: (data: ViewInput) => mutation.mutateAsync({ data }) };
}

export function useUpdateView() {
  const onSuccess = useOnViewSaved();
  const mutation = useUpdateViewMutation({ mutation: { onSuccess } });
  return { ...mutation, mutateAsync: ({ id, ...data }: ViewInput & { id: string }) => mutation.mutateAsync({ id, data }) };
}

export interface ViewPreview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  count?: number;
}

export const viewPreviewKeys = {
  all: ['view-preview'] as const,
  conditions: (conditions: ConditionGroup) => [...viewPreviewKeys.all, conditions] as const,
};

/**
 * Live count of an unsaved condition tree. A query (not the generated mutation) because the call
 * is a read: keyed by the tree it caches repeats, cancels superseded requests, and
 * `keepPreviousData` keeps the last count on screen while the next loads (no flicker; status is
 * `loading` with the stale `count`). Debouncing stays with the builder, which calls
 * `request(conditions)` when it wants a count. No request yet or `enabled: false` is `idle`; a
 * failed preview (e.g. a half-edited invalid tree) is `error` and the builder hides the count.
 */
export function usePreviewViewCount(
  options: { enabled?: boolean } = {},
): ViewPreview & { request: (conditions: ConditionGroup) => void } {
  const enabled = options.enabled ?? true;
  const [conditions, setConditions] = useState<ConditionGroup | undefined>(undefined);
  const query = useQuery({
    queryKey: conditions === undefined ? viewPreviewKeys.all : viewPreviewKeys.conditions(conditions),
    queryFn: ({ signal }) => previewViewCount({ conditions: conditions as ConditionGroup }, { signal }),
    enabled: enabled && conditions !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const request = useCallback((next: ConditionGroup) => setConditions(next), []);
  if (!enabled || conditions === undefined) return { status: 'idle', request };
  if (query.isError) return { status: 'error', request };
  if (query.data !== undefined && !query.isPlaceholderData) return { status: 'ready', count: query.data.count, request };
  if (query.data !== undefined) return { status: 'loading', count: query.data.count, request };
  return { status: 'loading', request };
}

export interface ViewBuilderLookups {
  roles: Role[];
  groups: GroupRef[];
  tags: TagRef[];
  /** Eligible owners across the groups the caller can send tickets to, de-duplicated. */
  owners: EligibleOwner[];
  isLoading: boolean;
  /** True when any picker lookup failed (403s included); the affected list is empty. */
  isError: boolean;
  /** Refetches only the lookups that failed. */
  refetch: () => void;
}

const EMPTY: never[] = [];

/**
 * Pickers for the builder. Roles load only when `canShare` (`GET /roles` needs role.view). Owners
 * come from `GET /groups/{id}/eligible-owners` for each destination group: agents lack user.view,
 * so `/users` is not used, and the list covers people who can own tickets in a group the caller
 * can reach. A failed lookup degrades to an empty list and sets `isError`.
 */
export function useViewBuilderLookups({ canShare }: { canShare: boolean }): ViewBuilderLookups {
  const roles = useListRoles<{ items: Role[] }>({ query: { queryKey: roleKeys.all, enabled: canShare, retry: false } });
  const groups = useListGroupDestinations<{ items: GroupRef[] }>({ query: { queryKey: groupKeys.destinations(), retry: false } });
  const tags = useListTags<{ items: TagRef[] }>(undefined, { query: { queryKey: tagKeys.search(undefined), retry: false } });
  const groupItems = groups.data?.items ?? EMPTY;
  const ownerQueries = useQueries({
    queries: groupItems.map((group) => ({
      queryKey: groupKeys.eligibleOwners(group.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => listEligibleOwners(group.id, { signal }),
      retry: false,
    })),
  });
  const ownerPages = ownerQueries.map((query) => query.data);
  const ownerKey = ownerPages.map((page) => page?.items.length ?? -1).join(',') + '|' + groupItems.map((g) => g.id).join(',');
  const owners = useMemo(() => {
    const byId = new Map<string, EligibleOwner>();
    for (const page of ownerPages) for (const owner of page?.items ?? EMPTY) byId.set(owner.id, owner);
    return [...byId.values()];
    // ownerKey stands in for the pages: the array identity changes every render.
  }, [ownerKey]);
  return {
    roles: canShare ? (roles.data?.items ?? EMPTY) : EMPTY,
    groups: groupItems,
    tags: tags.data?.items ?? EMPTY,
    owners,
    isError: (canShare && roles.isError) || groups.isError || tags.isError || ownerQueries.some((query) => query.isError),
    refetch: () => {
      if (canShare && roles.isError) void roles.refetch();
      if (groups.isError) void groups.refetch();
      if (tags.isError) void tags.refetch();
      for (const query of ownerQueries) if (query.isError) void query.refetch();
    },
    isLoading: (canShare && roles.isLoading) || groups.isLoading || tags.isLoading || ownerQueries.some((query) => query.isLoading),
  };
}

const ISSUE_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  too_small: 'This field is required.',
  too_long: 'This is too long.',
  too_big: 'There are too many entries.',
  invalid: 'This value is not valid.',
  invalid_type: 'This value is not valid.',
  invalid_value: 'Pick one of the available options.',
  invalid_format: 'This value is not valid.',
  unrecognized_key: 'This field is not supported.',
  unsupported_operator: 'This operator does not work with that field.',
  invalid_operator: 'This operator does not work with that field.',
};

/**
 * Submit failure -> API field path -> message (`name`, `conditions.items.2.operator`,
 * `sharedRoleIds.0`). Failures without a field (403, 404, anything else) come back under the
 * empty path `''` as a form-level message.
 */
export function mapViewSubmitError(error: unknown): Record<string, string> {
  const mapped = mapError(error);
  if (mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined) {
    return Object.fromEntries(
      Object.entries(mapped.fieldErrors).map(([path, issue]) => [
        path,
        ISSUE_MESSAGES[issue] ?? `${issue.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}.`,
      ]),
    );
  }
  if (mapped.code === 'PERMISSION_DENIED' || mapped.code === 'FORBIDDEN') return { '': "You don't have permission to share views." };
  if (mapped.code === 'VIEW_NOT_FOUND' || mapped.code === 'NOT_FOUND') return { '': 'This view no longer exists.' };
  return { '': mapped.message };
}
