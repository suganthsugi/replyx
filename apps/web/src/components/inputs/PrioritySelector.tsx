import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import { Priority } from '../../data/tickets';

/** The ticket's priority, as a small pill-shaped exclusive choice (docs/design-system triage chip). */

export interface PrioritySelectorProps {
  /** `null` for "unset" (e.g. an optional priority in `TriageBar` that hasn't been touched yet). */
  value: Priority | null;
  onChange: (value: Priority) => void;
  disabled?: boolean;
  label?: string;
}

const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export function PrioritySelector({ value, onChange, disabled = false, label = 'Priority' }: PrioritySelectorProps) {
  return (
    <ToggleButtonGroup
      value={value}
      exclusive
      disabled={disabled}
      size="small"
      aria-label={label}
      onChange={(_event, next: Priority | null) => {
        if (next !== null) onChange(next);
      }}
    >
      {Object.values(Priority).map((priority) => (
        <ToggleButton key={priority} value={priority}>
          {PRIORITY_LABELS[priority]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
