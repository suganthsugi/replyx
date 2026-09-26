import Chip from '@mui/material/Chip';

import type { SlaSummary } from '../../api/generated/model';

/**
 * A ticket's SLA status as a soft pill (docs/design-system "SLA pill"). Renders nothing until
 * there's SLA data to show — a ticket outside any policy has `status: 'none'`, not a badge with a
 * placeholder label. Showing the remaining time is T227's job once the policy target is wired up.
 */

const SLA_META: Record<Exclude<SlaSummary['status'], 'none'>, { label: string; tone: 'success' | 'warning' | 'error' }> = {
  ok: { label: 'On track', tone: 'success' },
  warning: { label: 'At risk', tone: 'warning' },
  breached: { label: 'Breached', tone: 'error' },
};

export interface SlaBadgeProps {
  sla: SlaSummary;
}

export function SlaBadge({ sla }: SlaBadgeProps) {
  if (sla.status === 'none') return null;
  const { label, tone } = SLA_META[sla.status];
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        height: 20,
        fontSize: '0.6875rem',
        fontWeight: 600,
        bgcolor: `${tone}.light`,
        color: `${tone}.main`,
      }}
    />
  );
}
