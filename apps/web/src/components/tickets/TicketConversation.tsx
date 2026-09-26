import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { EmptyState } from '../foundations/EmptyState';
import { useAnnounce } from '../foundations/LiveRegion';

import { HistoryTimelineEntry } from './HistoryTimeline';
import { InternalNoteCard } from './InternalNoteCard';
import { MessageBubble } from './MessageBubble';

import type { HistoryEvent } from './types';
import type { Message } from '../../data/messages';
import type { ReactNode } from 'react';

/**
 * A ticket's full activity, oldest at the top (reusing `ChatThread`'s scroll-anchoring: it opens
 * scrolled to the newest item, follows new activity while the reader is at the bottom, and loads
 * older history when scrolled to the top, keeping the reading position steady). Public messages,
 * internal notes and history events are interleaved in one timeline; new customer messages are
 * announced through the workspace's live region (ui-components rule 3).
 */

export type TicketConversationItem =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'event'; id: string; event: HistoryEvent };

export interface TicketConversationProps {
  items: readonly TicketConversationItem[];
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Shown instead of the list while there's no activity yet. */
  emptyState?: ReactNode;
}

const EDGE = 80;

export function TicketConversation({ items, hasOlder = false, loadingOlder = false, onLoadOlder, emptyState }: TicketConversationProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const previous = useRef<{ firstId?: string; lastId?: string; scrollHeight: number; atBottom: boolean }>({ scrollHeight: 0, atBottom: true });
  const announce = useAnnounce();

  const firstId = items[0]?.id;
  const last = items.at(-1);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const before = previous.current;
    if (before.lastId === undefined) {
      element.scrollTop = element.scrollHeight;
    } else if (firstId !== before.firstId && last?.id === before.lastId) {
      element.scrollTop += element.scrollHeight - before.scrollHeight;
    } else if (last?.id !== before.lastId && before.atBottom) {
      element.scrollTop = element.scrollHeight;
    }
    previous.current = { firstId, lastId: last?.id, scrollHeight: element.scrollHeight, atBottom: isAtBottom(element) };
  }, [firstId, last]);

  useAnnounceNewCustomerMessages(items, announce);

  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    previous.current.atBottom = isAtBottom(element);
    previous.current.scrollHeight = element.scrollHeight;
    if (element.scrollTop < EDGE && hasOlder && !loadingOlder) onLoadOlder?.();
  };

  return (
    <Box
      ref={scroller}
      component="section"
      aria-label="Ticket conversation"
      tabIndex={0}
      onScroll={onScroll}
      sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 4, py: 4, display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}
    >
      {hasOlder && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          {loadingOlder ? (
            <CircularProgress size={20} aria-label="Loading earlier activity" />
          ) : (
            <Button size="small" variant="text" onClick={onLoadOlder}>
              Show earlier activity
            </Button>
          )}
        </Box>
      )}
      {items.length === 0 ? (
        <Box sx={{ m: 'auto' }}>{emptyState ?? <EmptyState title="No messages yet" message="Replies and internal notes will appear here." />}</Box>
      ) : (
        <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0, mt: 'auto', display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {items.map((item) =>
            item.kind === 'event' ? (
              <HistoryTimelineEntry key={item.id} event={item.event} />
            ) : item.message.visibility === 'internal' ? (
              <InternalNoteCard key={item.id} message={item.message} />
            ) : (
              <MessageBubble key={item.id} message={item.message} />
            ),
          )}
        </Box>
      )}
    </Box>
  );
}

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < EDGE;
}

/** Announces public customer messages that arrive after the conversation is on screen. */
function useAnnounceNewCustomerMessages(items: readonly TicketConversationItem[], announce: (text: string) => void): void {
  // `null` until the first render: what's there on arrival is the page, not news.
  const lastSeen = useRef<string | undefined | null>(null);
  useEffect(() => {
    const previousLast = lastSeen.current;
    lastSeen.current = items.at(-1)?.id;
    if (previousLast === null) return;
    const from = previousLast === undefined ? -1 : items.findIndex((item) => item.id === previousLast);
    if (previousLast !== undefined && from === -1) return;
    for (const item of items.slice(from + 1)) {
      if (item.kind === 'message' && item.message.authorKind === 'customer') {
        announce(`${item.message.author?.name ?? 'Customer'} says: ${item.message.body}`);
      }
    }
  }, [items, announce]);
}
