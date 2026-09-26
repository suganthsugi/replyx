import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { VisuallyHidden } from '../foundations/VisuallyHidden';

import { SlaBadge } from './SlaBadge';
import { StatePill } from './StatePill';

import type { TicketSummary } from '../../api/generated/model';

/** Default row height `TicketList` virtualizes at; kept in sync with this row's padding. */
export const TICKET_ROW_HEIGHT = 84;

export interface TicketRowProps {
  ticket: TicketSummary;
  unread?: boolean;
  /** Whether this is the ticket currently open in the focus pane. */
  selected?: boolean;
}

/**
 * One row of the ticket list (docs/design-system "Workspace Inbox" list rows): state pill,
 * ticket number, an unread dot, the title, the customer's name and the SLA badge.
 */
export function TicketRow({ ticket, unread = false, selected = false }: TicketRowProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        px: 3.5,
        py: 2.5,
        overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <StatePill state={ticket.state} />
        <Typography variant="caption" color="text.secondary">
          #{ticket.number}
        </Typography>
        {unread && (
          <>
            <Box aria-hidden="true" component="span" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'primary.main' }} />
            <VisuallyHidden>Unread</VisuallyHidden>
          </>
        )}
      </Box>
      <Typography
        variant="body2"
        title={ticket.title}
        sx={{ fontWeight: selected ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {ticket.title}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ticket.customer.name}
        </Typography>
        <SlaBadge sla={ticket.sla} />
      </Box>
    </Box>
  );
}
