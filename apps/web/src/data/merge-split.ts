import { useQueryClient } from '@tanstack/react-query';

import {
  useBulkUpdateTickets as useBulkUpdateTicketsMutation,
  useMergeTicket as useMergeTicketMutation,
  useSplitTicket as useSplitTicketMutation,
} from '../api/generated/tickets/tickets';

import { mapError, type UiError } from './errors';
import { messageKeys } from './messages';
import { ticketKeys } from './tickets';

import type { BulkUpdateTickets200ResultsItem, BulkUpdateTicketsBodyChanges, Ticket } from '../api/generated/model';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Merge, split and bulk updates (US14). Components never import `api/generated/tickets` directly
 * (data-hooks rule 6). Each mutation patches what it knows from the response and invalidates the
 * rest; the `ticket.updated` / `ticket.created` / `message.moved` events that follow keep other
 * screens and other agents in sync through `useTicketListEvents` and `useTicketRoom`.
 */

/** UI text for the merge/split/bulk codes the screens show; other codes keep `mapError`'s text. */
const MESSAGES: Record<string, string> = {
  DIFFERENT_CUSTOMER: 'Only tickets from the same customer can be merged.',
  ALREADY_MERGED: 'One of these tickets has already been merged into another ticket.',
  SAME_TICKET: 'Choose a different ticket to merge into.',
  MESSAGE_NOT_SPLITTABLE: 'Internal notes cannot be split into a new ticket.',
  INVALID_TRANSITION: "The ticket can't move to that state from its current one.",
  OWNER_NOT_ELIGIBLE: "The owner can't edit tickets in this ticket's group.",
  TICKET_NOT_FOUND: 'The ticket no longer exists or you no longer have access to it.',
  PERMISSION_DENIED: "You don't have permission to change this ticket.",
  TAG_NOT_FOUND: 'One of the tags no longer exists.',
};

/** Message for an error code alone (bulk results carry only the code). */
export function ticketActionMessage(code: string): string {
  return MESSAGES[code] ?? 'This ticket could not be updated.';
}

export function mapTicketActionError(raw: unknown): UiError {
  const error = mapError(raw);
  const message = MESSAGES[error.code];
  return message === undefined ? error : { ...error, message };
}

function refreshTicket(queryClient: QueryClient, ticketId: string): void {
  void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.history(ticketId) });
  void queryClient.invalidateQueries({ queryKey: [...messageKeys.all, ticketId] });
}

function refreshLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'list'] });
}

/** Folds `sourceId` into another ticket of the same customer; resolves to the target ticket. */
export function useMergeTicket(sourceId: string) {
  const queryClient = useQueryClient();
  const mutation = useMergeTicketMutation({
    mutation: {
      onSuccess: (target: Ticket) => {
        queryClient.setQueryData(ticketKeys.detail(target.id), target);
        refreshTicket(queryClient, sourceId);
        refreshTicket(queryClient, target.id);
        refreshLists(queryClient);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: (targetTicketId: string) => mutation.mutateAsync({ id: sourceId, data: { targetTicketId } }),
    error: mutation.error ? mapTicketActionError(mutation.error) : undefined,
  };
}

export interface SplitInput {
  messageId: string;
  title?: string;
}

/** Moves one public message of `sourceId` into a new ticket; resolves to the new ticket. */
export function useSplitTicket(sourceId: string) {
  const queryClient = useQueryClient();
  const mutation = useSplitTicketMutation({
    mutation: {
      onSuccess: (created: Ticket) => {
        queryClient.setQueryData(ticketKeys.detail(created.id), created);
        refreshTicket(queryClient, sourceId);
        refreshLists(queryClient);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: ({ messageId, title }: SplitInput) =>
      mutation.mutateAsync({ id: sourceId, data: { messageId, ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }) } }),
    error: mutation.error ? mapTicketActionError(mutation.error) : undefined,
  };
}

export type BulkChanges = BulkUpdateTicketsBodyChanges;
export type BulkResult = BulkUpdateTickets200ResultsItem;

/** The bulk endpoint's limit (contracts/tickets.yaml `/tickets/bulk`). */
export const BULK_LIMIT = 100;

/**
 * The same changes on up to 100 tickets. Resolves to one result per ticket: the request succeeds
 * even when some tickets are refused, so callers report `ok: false` results themselves
 * (`ticketActionMessage(errorCode)`).
 */
export function useBulkUpdateTickets() {
  const queryClient = useQueryClient();
  const mutation = useBulkUpdateTicketsMutation({
    mutation: {
      onSuccess: (body) => {
        for (const result of body.results) if (result.ok) refreshTicket(queryClient, result.ticketId);
        refreshLists(queryClient);
      },
    },
  });
  return {
    ...mutation,
    mutateAsync: async (ticketIds: readonly string[], changes: BulkChanges): Promise<BulkResult[]> =>
      (await mutation.mutateAsync({ data: { ticketIds: [...ticketIds], changes } })).results,
    error: mutation.error ? mapTicketActionError(mutation.error) : undefined,
  };
}
