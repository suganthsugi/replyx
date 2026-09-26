import Box from '@mui/material/Box';
import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';
import Typography from '@mui/material/Typography';

import type { Priority } from '../../data/tickets';

/**
 * A ticket's priority as a small icon plus its name: an up-chevron for High, two for Urgent, a
 * down-chevron for Low, nothing for Normal. The word is always shown too, so priority never
 * depends on color or icon shape alone.
 */

function ChevronUpIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true" sx={{ fontSize: '0.875rem', ...props.sx }}>
      <path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z" />
    </SvgIcon>
  );
}

function ChevronDownIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true" sx={{ fontSize: '0.875rem', ...props.sx }}>
      <path d="M12 16l6-6-1.41-1.41L12 13.17l-4.59-4.58L6 10z" />
    </SvgIcon>
  );
}

const PRIORITY_META: Record<Priority, { label: string; tone: string; icon?: 'up' | 'double-up' | 'down' }> = {
  urgent: { label: 'Urgent', tone: 'error.main', icon: 'double-up' },
  high: { label: 'High', tone: 'warning.main', icon: 'up' },
  normal: { label: 'Normal', tone: 'text.secondary' },
  low: { label: 'Low', tone: 'text.secondary', icon: 'down' },
};

export interface PriorityMarkProps {
  priority: Priority;
}

export function PriorityMark({ priority }: PriorityMarkProps) {
  const meta = PRIORITY_META[priority];
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: meta.tone }}>
      {meta.icon === 'up' && <ChevronUpIcon />}
      {meta.icon === 'double-up' && (
        <Box aria-hidden="true" component="span" sx={{ display: 'inline-flex' }}>
          <ChevronUpIcon />
          <ChevronUpIcon sx={{ ml: '-6px' }} />
        </Box>
      )}
      {meta.icon === 'down' && <ChevronDownIcon />}
      <Typography variant="caption" component="span" sx={{ fontWeight: 600, color: 'inherit' }}>
        {meta.label}
      </Typography>
    </Box>
  );
}
