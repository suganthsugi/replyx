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

/**
 * What `mutateAsync` resolves to. `alreadyTriaged` marks a lost race whose winner sent the ticket
 * to a group the caller can't see: the server answers 404 (it won't confirm a ticket the caller
 * has no access to), which for triage can only mean the ticket left Ungrouped.
 */
export type TriageOutcome = TriageTicket200 & { alreadyTriaged?: true };

function dropTicket(queryClient: QueryClient, ticketId: string): void {
  removeFromLists(queryClient, ticketId);
  queryClient.removeQueries({ queryKey: ticketKeys.detail(ticketId) });
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
          dropTicket(queryClient, ticketId);
        }
        refreshAfterTriage(queryClient, ticketId);
      },
      onError: (error) => {
        const code = mapError(error).code;
        if (code === 'ALREADY_TRIAGED') {
          // Shows where it went; a failed refetch just leaves the cached ticket.
          queryClient
            .fetchQuery({ queryKey: ticketKeys.detail(ticketId), queryFn: ({ signal }) => getTicket(ticketId, { signal }), staleTime: 0 })
            .catch(() => undefined);
          refreshAfterTriage(queryClient, ticketId);
        } else if (code === 'TICKET_NOT_FOUND') {
          dropTicket(queryClient, ticketId);
          refreshAfterTriage(queryClient, ticketId);
        }
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: async (data: TriageTicketBody): Promise<TriageOutcome> => {
      try {
        return await mutation.mutateAsync({ id: ticketId, data });
      } catch (error) {
        if (mapError(error).code === 'TICKET_NOT_FOUND') return { visibleToCaller: false, alreadyTriaged: true };
        throw error;
      }
    },
    error: mutation.error && mapError(mutation.error).code !== 'TICKET_NOT_FOUND' ? mapError(mutation.error) : undefined,
  };
}

export type { TriageTicket200, TriageTicketBody };
