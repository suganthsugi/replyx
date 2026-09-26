import Box from '@mui/material/Box';
import { useLayoutEffect, useRef, useState } from 'react';

import { EmptyState } from '../foundations/EmptyState';

import { TICKET_ROW_HEIGHT, TicketRow } from './TicketRow';
import { useVirtualRows } from './virtualization';

import type { TicketSummary } from '../../data/tickets';
import type { FocusEvent, KeyboardEvent } from 'react';

/**
 * The virtualized, keyboard-navigable ticket list for a view (docs/design-system "Workspace
 * Inbox" list pane): arrow keys move the active ticket, Enter/Space opens it. Loading and error
 * are the page's job (ui-components rule 2, it owns the query); this component only renders the
 * "all caught up" empty state for a view with no tickets right now.
 */

export interface TicketListProps {
  tickets: readonly TicketSummary[];
  /** Accessible name for the list, e.g. the view's name ("My tickets"). */
  label: string;
  selectedId?: string;
  unreadIds?: ReadonlySet<string>;
  onOpenTicket: (ticket: TicketSummary) => void;
  emptyTitle?: string;
  emptyMessage?: string;
  rowHeight?: number;
  height?: number | string;
}

export function TicketList({
  tickets,
  label,
  selectedId,
  unreadIds,
  onOpenTicket,
  emptyTitle = 'All caught up',
  emptyMessage = 'No tickets match this view right now.',
  rowHeight = TICKET_ROW_HEIGHT,
  height = '100%',
}: TicketListProps) {
  const { containerRef, onScroll, range, scrollToRow } = useVirtualRows({ count: tickets.length, rowHeight });
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef(false);
  // Whether focus is currently inside the list, tracked via focusin/focusout (bubbling)
  // instead of `document.activeElement`: when a shrink removes the focused row in the same
  // commit, the browser has already moved `document.activeElement` to <body> by the time our
  // layout effect below runs, so that check can never see the row was focused.
  const focusWithinRef = useRef(false);

  // Keep the roving tab stop in range when the list shrinks (a view switch, a live update
  // removing a ticket, a refetch). If focus was inside the list when its target row disappeared,
  // flag that focus should follow the clamped row instead of falling through to <body>.
  useLayoutEffect(() => {
    const maxIndex = Math.max(0, tickets.length - 1);
    if (activeIndex > maxIndex) {
      if (focusWithinRef.current) {
        pendingFocusRef.current = true;
      }
      setActiveIndex(maxIndex);
    }
  }, [tickets.length, activeIndex]);

  // Focus the active row once it has a mounted ref. Keyboard navigation (or the clamp above) may
  // target a row outside the currently virtualized range; this retries as `range` grows to
  // include it, instead of assuming a fixed scroll timing.
  useLayoutEffect(() => {
    if (!pendingFocusRef.current) return;
    const node = rowRefs.current.get(activeIndex);
    if (node !== undefined) {
      node.focus();
      pendingFocusRef.current = false;
    }
  }, [activeIndex, range]);

  const focusRow = (index: number) => {
    if (tickets.length === 0) return;
    const clamped = Math.max(0, Math.min(index, tickets.length - 1));
    pendingFocusRef.current = true;
    setActiveIndex(clamped);
    scrollToRow(clamped);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (tickets.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(activeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(tickets.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      const ticket = tickets[activeIndex];
      if (ticket !== undefined) {
        event.preventDefault();
        onOpenTicket(ticket);
      }
    }
  };

  if (tickets.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <Box
      ref={(node: HTMLDivElement | null) => {
        containerRef(node);
        containerElRef.current = node;
      }}
      role="listbox"
      aria-label={label}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onFocus={() => {
        focusWithinRef.current = true;
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        const related = event.relatedTarget as Node | null;
        // Only treat this as "focus left the list" when we know focus landed somewhere else
        // outside it. A `null` relatedTarget is ambiguous (it also happens when the focused row
        // is removed from the DOM), so it's left as still-inside rather than cleared.
        if (related !== null && containerElRef.current?.contains(related) !== true) {
          focusWithinRef.current = false;
        }
      }}
      sx={{ height, overflowY: 'auto', position: 'relative' }}
    >
      <Box sx={{ height: range.totalHeight, position: 'relative' }}>
        <Box sx={{ position: 'absolute', top: range.offsetY, left: 0, right: 0 }}>
          {tickets.slice(range.startIndex, range.endIndex).map((ticket, offset) => {
            const index = range.startIndex + offset;
            const selected = ticket.id === selectedId;
            return (
              <Box
                key={ticket.id}
                ref={(node: HTMLDivElement | null) => {
                  if (node === null) rowRefs.current.delete(index);
                  else rowRefs.current.set(index, node);
                }}
                role="option"
                aria-selected={selected}
                aria-setsize={tickets.length}
                aria-posinset={index + 1}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onClick={() => {
                  setActiveIndex(index);
                  onOpenTicket(ticket);
                }}
                sx={{
                  height: rowHeight,
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                  borderBottom: 1,
                  borderColor: 'divider',
                  bgcolor: selected ? 'action.selected' : 'background.paper',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <TicketRow ticket={ticket} unread={unreadIds?.has(ticket.id) ?? false} selected={selected} />
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
