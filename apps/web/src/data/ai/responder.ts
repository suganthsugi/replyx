import { useEffect } from 'react';

import { conversationKeys } from '../conversation';
import { RESPONDER_SCOPE_CHANGED } from '../socket';
import { ticketKeys } from '../ticket-keys';

import type { GetConversation200, Responder } from '../../api/generated/model';
import type { RealtimeClient } from '../socket';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';

/**
 * Who is answering a conversation (specs/002-ai-assist US3). `conversation.responder_changed`
 * (`{ ticketId, responder }`; customers get it without `ticketId`) patches `responder` in the
 * cache. `ai.responder_scope_changed` (a control signal for the whole tenant, no seq) refetches
 * instead, so `responder` and `ai.canTakeOver` / `canHandBack` are recomputed.
 */

type ThreadData = InfiniteData<GetConversation200, string | undefined>;

/** Staff: mount on the ticket page. Patches the ticket detail; refetches open details on a scope change. */
export function useTicketResponderEvents(client: RealtimeClient | undefined, ticketId: string | undefined): void {
  useEffect(() => {
    if (!client || ticketId === undefined) return undefined;
    const off = [
      client.onEvent('conversation.responder_changed', (envelope, queryClient) => {
        const data = envelope.data as { ticketId?: string; responder: Responder };
        if (data.ticketId !== undefined && data.ticketId !== ticketId) return;
        queryClient.setQueryData<{ responder?: Responder } | undefined>(ticketKeys.detail(ticketId), (ticket) => (ticket === undefined ? ticket : { ...ticket, responder: data.responder }));
        void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      }),
      client.onSignal(RESPONDER_SCOPE_CHANGED, (queryClient) => {
        // Tenant-wide: every cached ticket detail may now have another responder or take-over rights.
        void queryClient.invalidateQueries({ queryKey: [...ticketKeys.all, 'detail'] });
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client, ticketId]);
}

function setThreadResponder(queryClient: QueryClient, responder: Responder): void {
  queryClient.setQueryData<ThreadData>(conversationKeys.thread(), (data) => {
    const [first, ...rest] = data?.pages ?? [];
    return data === undefined || first === undefined ? data : { ...data, pages: [{ ...first, responder }, ...rest] };
  });
}

/** Customer chat: mount where the conversation is shown. Updates the badge's `responder` live. */
export function useConversationResponderEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    const off = [
      client.onEvent('conversation.responder_changed', (envelope, queryClient) => {
        setThreadResponder(queryClient, (envelope.data as { responder: Responder }).responder);
      }),
      client.onSignal(RESPONDER_SCOPE_CHANGED, (queryClient) => {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.thread() });
      }),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client]);
}
