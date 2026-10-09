import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getTicketAiDraft, useDiscardTicketAiDraft } from '../../api/generated/ai/ai';
import { mapError } from '../errors';

import { isApiCode } from './storeConnection';

import type { AiDraft } from '../../api/generated/model';
import type { RealtimeClient } from '../socket';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The AI reply draft for a ticket (specs/002-ai-assist US3): staff with reply access see it in
 * the composer. `ai.draft_ready` (`{ ticketId, draftId }`, on the ticket stream) refetches it.
 * Sending a reply with `aiDraftId` (see `useSendTicketMessage`) or discarding clears it.
 */

export const aiDraftKeys = {
  all: ['ai-drafts'] as const,
  detail: (ticketId: string) => [...aiDraftKeys.all, ticketId] as const,
};

/** `data` is `null` when the ticket has no draft (404 `AI_DRAFT_NOT_FOUND`), not an error. */
export function useAiDraft(ticketId: string | undefined, enabled = true) {
  const query = useQuery<AiDraft | null, Error>({
    queryKey: aiDraftKeys.detail(ticketId ?? ''),
    queryFn: async ({ signal }) => {
      try {
        return await getTicketAiDraft(ticketId ?? '', { signal });
      } catch (error) {
        if (isApiCode(error, 404, 'AI_DRAFT_NOT_FOUND')) return null;
        throw error;
      }
    },
    enabled: enabled && ticketId !== undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Empties the cached draft for a ticket (after a reply sent from it, or a discard). */
export function clearAiDraft(queryClient: QueryClient, ticketId: string): void {
  queryClient.setQueryData<AiDraft | null>(aiDraftKeys.detail(ticketId), null);
}

export function useDiscardAiDraft(ticketId: string) {
  const queryClient = useQueryClient();
  const mutation = useDiscardTicketAiDraft({ mutation: { onSuccess: () => clearAiDraft(queryClient, ticketId) } });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync({ id: ticketId }) };
}

/** `ai.draft_ready` for this ticket refetches its draft; mount where the composer is shown. */
export function useAiDraftEvents(client: RealtimeClient | undefined, ticketId: string | undefined): void {
  useEffect(() => {
    if (!client || ticketId === undefined) return undefined;
    return client.onEvent('ai.draft_ready', (envelope, queryClient) => {
      const data = envelope.data as { ticketId: string };
      if (data.ticketId !== ticketId) return;
      void queryClient.invalidateQueries({ queryKey: aiDraftKeys.detail(ticketId) });
    });
  }, [client, ticketId]);
}

export type { AiDraft };
