import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

import { useAnnounce } from '../foundations/LiveRegion';

import { ChatBubble } from './ChatBubble';
import { ResolvedMarker } from './ResolvedMarker';
import { StatusLine } from './StatusLine';
import { TypingDots } from './TypingDots';

import type { ChatItem, ChatMessage, ChatStatus, TypingIndicator } from './types';

/**
 * The customer's one continuous conversation, oldest at the top. It opens scrolled to the newest
 * message, follows new messages while the reader is at the bottom (or just sent one), and loads
 * older history when scrolled to the top (or with "Show earlier messages" from the keyboard),
 * keeping the reading position steady as the older page arrives. History comes in pages and
 * off-screen bubbles skip layout, so long threads stay light.
 *
 * New support messages and typing are announced through the area's live region (ui-components
 * rule 3); history that loads in is not.
 */

export interface ChatThreadProps {
  items: ChatItem[];
  status?: ChatStatus;
  typing?: TypingIndicator | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry?: (message: ChatMessage) => void;
  /** Shown instead of the list while there are no messages (the welcome card). */
  emptyState?: ReactNode;
}

/** How close to an edge (px) counts as "at" it. */
const EDGE = 80;

export function ChatThread({ items, status, typing, hasOlder, loadingOlder, onLoadOlder, onRetry, emptyState }: ChatThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const previous = useRef<{ firstId?: string; lastId?: string; scrollHeight: number; atBottom: boolean }>({ scrollHeight: 0, atBottom: true });
  const announce = useAnnounce();

  const firstId = items[0]?.id;
  const last = items.at(-1);

  // Keep the view anchored: older history above keeps the reader's place, new messages below
  // follow the reader if they were at the bottom or wrote the message themselves.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const before = previous.current;
    if (before.lastId === undefined) {
      element.scrollTop = element.scrollHeight;
    } else if (firstId !== before.firstId && last?.id === before.lastId) {
      element.scrollTop += element.scrollHeight - before.scrollHeight;
    } else if (last?.id !== before.lastId && (before.atBottom || (last?.kind === 'message' && last.from === 'me'))) {
      element.scrollTop = element.scrollHeight;
    }
    previous.current = { firstId, lastId: last?.id, scrollHeight: element.scrollHeight, atBottom: isAtBottom(element) };
  }, [firstId, last, typing]);

  useAnnounceNewSupportMessages(items, announce);

  const typingName = typing?.name;
  useEffect(() => {
    if (typingName !== undefined) announce(`${typingName} is typing`);
  }, [typingName, announce]);

  const statusText = status?.text;
  const firstStatus = useRef(true);
  useEffect(() => {
    if (statusText === undefined) return;
    // The status on load is just the page; changes after that are news.
    if (firstStatus.current) firstStatus.current = false;
    else announce(statusText);
  }, [statusText, announce]);

  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    previous.current.atBottom = isAtBottom(element);
    previous.current.scrollHeight = element.scrollHeight;
    if (element.scrollTop < EDGE && hasOlder && !loadingOlder) onLoadOlder();
  };

  return (
    <Box
      ref={scroller}
      component="section"
      aria-label="Conversation"
      // Scrollable regions must be reachable by keyboard (arrow keys scroll it).
      tabIndex={0}
      onScroll={onScroll}
      sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 4, py: 4, display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}
    >
      {hasOlder && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          {loadingOlder ? (
            <CircularProgress size={20} aria-label="Loading earlier messages" />
          ) : (
            <Button size="small" variant="text" onClick={onLoadOlder}>
              Show earlier messages
            </Button>
          )}
        </Box>
      )}
      {items.length === 0 && emptyState !== undefined ? (
        <Box sx={{ m: 'auto' }}>{emptyState}</Box>
      ) : (
        <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0, mt: 'auto', display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {items.map((item) =>
            item.kind === 'resolved' ? <ResolvedMarker key={item.id} marker={item} /> : <ChatBubble key={item.id} message={item} onRetry={onRetry} />,
          )}
        </Box>
      )}
      {typing != null && <TypingDots typing={typing} />}
      {status !== undefined && items.length > 0 && typing == null && <StatusLine status={status} />}
    </Box>
  );
}

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < EDGE;
}

/**
 * Announces support messages that arrive after the thread is on screen. Only messages after the
 * previous last item count, so older pages loading in (above) stay quiet.
 */
function useAnnounceNewSupportMessages(items: ChatItem[], announce: (text: string) => void): void {
  // `null` until the first render: what's there on arrival is the page, not news.
  const lastSeen = useRef<string | undefined | null>(null);
  useEffect(() => {
    const previousLast = lastSeen.current;
    lastSeen.current = items.at(-1)?.id;
    if (previousLast === null) return;
    // An empty thread counts everything as new; otherwise only what follows the old last item.
    const from = previousLast === undefined ? -1 : items.findIndex((item) => item.id === previousLast);
    if (previousLast !== undefined && from === -1) return;
    for (const item of items.slice(from + 1)) {
      if (item.kind === 'message' && item.from === 'support') announce(`${item.sender?.name ?? 'Support'} says: ${item.body}`);
    }
  }, [items, announce]);
}
