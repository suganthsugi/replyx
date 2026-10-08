import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import type { BulkChanges } from '../../data/merge-split';

/**
 * The bar under the ticket list while tickets are checked (US14, FR-041): one change at a time to
 * every checked ticket. It only collects the change; the caller runs `useBulkUpdateTickets` and
 * reports per-ticket refusals. Pending states need a date, so the state menu offers only the
 * states that don't.
 */

export interface BulkActionBarProps {
  count: number;
  busy?: boolean;
  /** Present when the signed-in agent can be assigned (has an id). */
  onAssignToMe?: () => void;
  onApply: (changes: BulkChanges) => void;
  onClear: () => void;
}

const STATES: { value: NonNullable<BulkChanges['state']>; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITIES: { value: NonNullable<BulkChanges['priority']>; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function BulkActionBar({ count, busy = false, onAssignToMe, onApply, onClear }: BulkActionBarProps) {
  const [state, setState] = useState('');
  const [priority, setPriority] = useState('');

  return (
    <Box
      role="toolbar"
      aria-label="Bulk actions"
      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, px: 3, py: 2, borderTop: 1, borderColor: 'divider', bgcolor: 'action.selected' }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, mr: 1 }}>
        {count} selected
      </Typography>
      <TextField
        select
        size="small"
        label="Set state"
        value={state}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value as NonNullable<BulkChanges['state']>;
          setState('');
          onApply({ state: value });
        }}
        sx={{ minWidth: 130 }}
      >
        {STATES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        label="Set priority"
        value={priority}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value as NonNullable<BulkChanges['priority']>;
          setPriority('');
          onApply({ priority: value });
        }}
        sx={{ minWidth: 130 }}
      >
        {PRIORITIES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
      {onAssignToMe !== undefined && (
        <Button size="small" variant="outlined" onClick={onAssignToMe} disabled={busy}>
          Assign to me
        </Button>
      )}
      <Button size="small" onClick={onClear} disabled={busy}>
        Clear selection
      </Button>
    </Box>
  );
}
