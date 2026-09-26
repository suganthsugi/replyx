import Chip from '@mui/material/Chip';

import type { TicketState } from '../../data/tickets';

/**
 * A ticket's state as a soft-background pill with strong, uppercase text (docs/design-system
 * "Status badge"). The label itself carries the meaning, not just the color, so it reads fine
 * without color vision.
 */

const STATE_META: Record<TicketState, { label: string; tone: 'primary' | 'warning' | 'success' | 'neutral' }> = {
  new: { label: 'New', tone: 'primary' },
  open: { label: 'Open', tone: 'primary' },
  pending_reminder: { label: 'Pending', tone: 'warning' },
  pending_close: { label: 'Pending', tone: 'warning' },
  resolved: { label: 'Resolved', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export interface StatePillProps {
  state: TicketState;
}

export function StatePill({ state }: StatePillProps) {
  const { label, tone } = STATE_META[state];
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        height: 20,
        fontSize: '0.625rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        bgcolor: tone === 'neutral' ? 'action.hover' : `${tone}.light`,
        color: tone === 'neutral' ? 'text.secondary' : `${tone}.main`,
      }}
    />
  );
}
