import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { searchTickets } from '../api/generated/tickets/tickets';

import { mapError } from './errors';

import type { SearchCustomerResult, SearchResult, SearchTicketResult, SearchTicketsType } from '../api/generated/model';

/**
 * Search (FR-070): access-filtered tickets and customers. The command bar uses `useQuickSearch`
 * (debounced, small page, one request); the results page uses `useSearchResults` (cursor paged).
 * Only typed parameters reach the generated client, never a raw query string.
 */

export type SearchScope = SearchTicketsType;

export const SEARCH_QUICK_LIMIT = 8;
export const SEARCH_PAGE_LIMIT = 25;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX_QUERY_LENGTH = 200;

export const searchKeys = {
  all: ['search'] as const,
  quick: (q: string) => [...searchKeys.all, 'quick', q] as const,
  results: (q: string, type: SearchScope) => [...searchKeys.all, 'results', type, q] as const,
};

/** Trimmed query clamped to the API maximum; empty means "do not search". */
export function normalizeSearchQuery(q: string): string {
  return q.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Command bar: debounced, `type=all`, small limit; disabled for empty or whitespace-only input. */
export function useQuickSearch(rawQuery: string, options: { limit?: number; debounceMs?: number } = {}) {
  const { limit = SEARCH_QUICK_LIMIT, debounceMs = SEARCH_DEBOUNCE_MS } = options;
  const q = normalizeSearchQuery(useDebouncedValue(rawQuery, debounceMs));
  const query = useQuery({
    queryKey: [...searchKeys.quick(q), limit] as const,
    queryFn: ({ signal }) => searchTickets({ q, type: 'all', limit }, { signal }),
    enabled: q.length > 0,
    staleTime: 10_000,
  });
  return {
    ...query,
    query: q,
    data: q.length > 0 ? query.data?.items : undefined,
    error: query.error ? mapError(query.error) : undefined,
  };
}

/** Results page: cursor-paged ("load more") with a type filter. Disabled for empty queries. */
export function useSearchResults(rawQuery: string, type: SearchScope = 'all') {
  const q = normalizeSearchQuery(rawQuery);
  const query = useInfiniteQuery({
    queryKey: searchKeys.results(q, type),
    queryFn: ({ pageParam, signal }) =>
      searchTickets({ q, type, limit: SEARCH_PAGE_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: q.length > 0,
  });
  return {
    ...query,
    query: q,
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    error: query.error ? mapError(query.error) : undefined,
  };
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';

/**
 * Splits a highlight string on the U+27E6/U+27E7 markers into plain-text segments. Never produces
 * HTML; render each `text` as a React text node. Unbalanced or nested markers are tolerated.
 */
export function splitHighlight(highlight: string | undefined | null): HighlightSegment[] {
  if (!highlight) return [];
  const segments: HighlightSegment[] = [];
  let buffer = '';
  let inMatch = false;
  const flush = () => {
    if (buffer !== '') segments.push({ text: buffer, match: inMatch });
    buffer = '';
  };
  for (const char of highlight) {
    if (char === MARK_OPEN) {
      flush();
      inMatch = true;
    } else if (char === MARK_CLOSE) {
      flush();
      inMatch = false;
    } else {
      buffer += char;
    }
  }
  flush();
  return segments;
}

export const isTicketResult = (result: SearchResult): result is SearchTicketResult => result.type === 'ticket';
export const isCustomerResult = (result: SearchResult): result is SearchCustomerResult => result.type === 'customer';

export type { SearchCustomerResult, SearchResult, SearchTicketResult };
