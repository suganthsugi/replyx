import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { EmptyState } from '../foundations/EmptyState';

import type { HistoryEvent } from './types';

/**
 * A ticket's audit trail as centered, secondary lines (docs/design-system "Timeline event"), e.g.
 * "Priority set to High by Sam". `HistoryTimelineEntry` renders one line and is also used by
 * `TicketConversation` to interleave events between messages.
 */

export function HistoryTimelineEntry({ event }: { event: HistoryEvent }) {
  return (
    <Typography component="li" variant="caption" color="text.secondary" sx={{ listStyle: 'none', textAlign: 'center', my: 0.5 }}>
      {event.text}
    </Typography>
  );
}

export interface HistoryTimelineProps {
  events: readonly HistoryEvent[];
  /** Accessible name for the list, when it's shown on its own (not interleaved by `TicketConversation`). */
  label?: string;
}

export function HistoryTimeline({ events, label = 'Ticket history' }: HistoryTimelineProps) {
  if (events.length === 0) {
    return <EmptyState title="No history yet" message="Changes to this ticket will appear here." />;
  }
  return (
    <Box component="ol" aria-label={label} sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {events.map((event) => (
        <HistoryTimelineEntry key={event.id} event={event} />
      ))}
    </Box>
  );
}
