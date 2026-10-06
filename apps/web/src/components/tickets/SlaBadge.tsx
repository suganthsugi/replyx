import Chip from '@mui/material/Chip';

import { WarningIcon } from '../foundations/icons';
import { useNow } from '../foundations/useNow';
import { VisuallyHidden } from '../foundations/VisuallyHidden';

import { presentSla } from './sla-time';

import type { SlaSummary } from '../../data/tickets';

/**
 * A ticket's SLA status as a soft pill (docs/design-system "SLA pill"): the time left to the next
 * due time ("12m left"), or "Overdue 5m" once it has passed, updating on the shared clock
 * (`useNow`). Renders nothing for a ticket outside any policy (`status: 'none'`). The pill's
 * visible text is hidden from assistive technology in favour of a full sentence that names the
 * target ("First response due in 12 minutes"). Staff screens only; the customer UI has no SLA.
 */

export interface SlaBadgeProps {
  sla: SlaSummary;
}

export function SlaBadge({ sla }: SlaBadgeProps) {
  const now = useNow();
  const shown = presentSla(sla, now);
  if (shown === null) return null;
  const { tone, text, label } = shown;
  return (
    <Chip
      size="small"
      label={
        <>
          <span aria-hidden="true">{text}</span>
          <VisuallyHidden>{label}</VisuallyHidden>
        </>
      }
      icon={tone === 'success' ? undefined : <WarningIcon />}
      data-sla-status={tone}
      sx={{
        height: 20,
        fontSize: '0.6875rem',
        fontWeight: 600,
        bgcolor: `${tone}.light`,
        color: `${tone}.main`,
        // A shape as well as a color marks a pill that needs attention (WCAG 1.4.1).
        '& .MuiChip-icon': { color: 'inherit', fontSize: 14, ml: 1.5 },
      }}
    />
  );
}
