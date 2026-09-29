import { useQueryClient } from '@tanstack/react-query';

import { getTicket, useTriageTicket as useTriageTicketMutation } from '../api/generated/tickets/tickets';

import { mapError } from './errors';
import { ticketKeys } from './tickets';
import { viewCountKeys } from './view-counts';

import type { Ticket, TicketSummary, TriageTicket200, TriageTicketBody } from '../api/generated/model';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Triage (US5, FR-063): sets the group and optionally owner/priority/tags of an ungrouped ticket
 * in one step. Components never import `api/generated/tickets` directly (data-hooks rule 6).
 *
 * `useTriageTicket(ticketId)` returns `mutateAsync(data)` resolving to the server's
 * `TriageTicket200`; callers (the TriageBar) read `visibleToCaller` on that result to decide
 * whether to keep the ticket focused or close it, the same way `useTicketRemovedFromView` closes a
 * ticket that dropped out of access (see run-log P8-8, `data/tickets.ts`).
 */

function findListQueries(queryClient: QueryClient) {
  return queryClient.getQueryCache().findAll({ queryKey: [...ticketKeys.all, 'list'] });
}

function removeFromLists(queryClient: QueryClient, ticketId: string): void {
  for (const query of findListQueries(queryClient)) {
    queryClient.setQueryData<{ pages: Array<{ items: TicketSummary[] }> }>(query.queryKey, (data) =>
      data === undefined
        ? data
        : { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== ticketId) })) },
    );
  }
}

function refreshAfterTriage(queryClient: QueryClient, ticketId: string): void {
  void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === ticketKeys.all[0] && query.queryKey[1] === 'list' });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.history(ticketId) });
  void queryClient.invalidateQueries({ queryKey: viewCountKeys.all });
}

/** One-step triage of an ungrouped ticket: sets its group and optionally owner, priority and tags. */
export function useTriageTicket(ticketId: string) {
  const queryClient = useQueryClient();
  const mutation = useTriageTicketMutation({
    mutation: {
      onSuccess: (result: TriageTicket200) => {
        if (result.visibleToCaller && result.ticket) {
          queryClient.setQueryData<Ticket>(ticketKeys.detail(ticketId), result.ticket);
        } else {
          removeFromLists(queryClient, ticketId);
          queryClient.removeQueries({ queryKey: ticketKeys.detail(ticketId) });
        }
        refreshAfterTriage(queryClient, ticketId);
      },
      onError: (error) => {
        if (mapError(error).code === 'ALREADY_TRIAGED') {
          void queryClient.fetchQuery({ queryKey: ticketKeys.detail(ticketId), queryFn: ({ signal }) => getTicket(ticketId, { signal }), staleTime: 0 });
          refreshAfterTriage(queryClient, ticketId);
        }
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (data: TriageTicketBody) => mutation.mutateAsync({ id: ticketId, data }),
    error: mutation.error ? mapError(mutation.error) : undefined,
  };
}

export type { TriageTicket200, TriageTicketBody };
