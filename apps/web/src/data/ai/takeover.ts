import { useQueryClient } from '@tanstack/react-query';

import { useHandTicketBackToAi, useTakeOverTicketFromAi } from '../../api/generated/ai/ai';
import { mapError, type UiError } from '../errors';
import { ticketKeys } from '../tickets';

import type { Responder } from '../../api/generated/model';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Take a conversation over from the assistant, or hand it back (specs/002-ai-assist US3, FR-030).
 * Both return the new `Responder`; the ticket detail's `responder` is patched and the detail is
 * refetched so `ai.canTakeOver` / `ai.canHandBack` / `ai.stopped` follow.
 */

const MESSAGES: Record<string, string> = {
  OWNER_NOT_ALLOWED: "You can't take over this ticket because you can't be its owner. Ask an admin to give you access to its group.",
  AI_NOT_IN_AUTO_MODE: 'The assistant is not answering this conversation, so there is nothing to take over.',
  AI_PAUSED: 'AI is paused right now. Resume it in AI settings first.',
};

/** Like `mapError`, with plain-language text for the take-over and hand-back conflicts. */
export function mapTakeoverError(raw: unknown): UiError {
  const error = mapError(raw);
  const message = MESSAGES[error.code];
  return message === undefined ? error : { ...error, message };
}

export function applyResponder(queryClient: QueryClient, ticketId: string, responder: Responder): void {
  queryClient.setQueryData<{ responder?: Responder } | undefined>(ticketKeys.detail(ticketId), (ticket) => (ticket === undefined ? ticket : { ...ticket, responder }));
  void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
}

export function useTakeOver(ticketId: string) {
  const queryClient = useQueryClient();
  const mutation = useTakeOverTicketFromAi({ mutation: { onSuccess: (responder) => applyResponder(queryClient, ticketId, responder) } });
  return { ...mutation, error: mutation.error ? mapTakeoverError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync({ id: ticketId }) };
}

export function useHandBack(ticketId: string) {
  const queryClient = useQueryClient();
  const mutation = useHandTicketBackToAi({ mutation: { onSuccess: (responder) => applyResponder(queryClient, ticketId, responder) } });
  return { ...mutation, error: mutation.error ? mapTakeoverError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync({ id: ticketId }) };
}

export type { Responder };
