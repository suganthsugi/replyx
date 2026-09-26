import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import { useId } from 'react';

import { TicketState } from '../../api/generated/model';

import type { ChangeEvent } from 'react';

/**
 * The ticket's state, with the date/time the two pending states need (docs/design-system
 * "State and SLA badges"). `pendingUntil` only applies while `value` is one of the pending
 * states; picking one of them fills a default so the field is never silently left empty.
 */

export interface StateSelectorProps {
  value: TicketState;
  /** ISO 8601 datetime; only meaningful while `value` is a pending state. */
  pendingUntil: string | null;
  onChange: (next: { state: TicketState; pendingUntil: string | null }) => void;
  disabled?: boolean;
  /** Earliest datetime the picker allows; ISO 8601. Defaults to now. */
  minPendingUntil?: string;
  error?: string;
}

const STATE_LABELS: Record<TicketState, string> = {
  new: 'New',
  open: 'Open',
  pending_reminder: 'Pending (reminder)',
  pending_close: 'Pending (auto-close)',
  resolved: 'Resolved',
  closed: 'Closed',
};

function isPendingState(state: TicketState): boolean {
  return state === TicketState.pending_reminder || state === TicketState.pending_close;
}

/** `datetime-local`'s value format, in the browser's local time; `''` when there's nothing to show. */
function toLocalInputValue(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(local: string): string | null {
  if (local === '') return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function StateSelector({ value, pendingUntil, onChange, disabled = false, minPendingUntil, error }: StateSelectorProps) {
  const selectLabelId = useId();
  const pending = isPendingState(value);

  const handleStateChange = (event: SelectChangeEvent) => {
    const next = event.target.value as TicketState;
    const nextPendingUntil = isPendingState(next) ? (pendingUntil ?? minPendingUntil ?? new Date().toISOString()) : null;
    onChange({ state: next, pendingUntil: nextPendingUntil });
  };

  const handlePendingUntilChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ state: value, pendingUntil: fromLocalInputValue(event.target.value) });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <FormControl error={error !== undefined} disabled={disabled} fullWidth size="small">
        <InputLabel id={selectLabelId}>State</InputLabel>
        <Select labelId={selectLabelId} label="State" value={value} onChange={handleStateChange}>
          {Object.values(TicketState).map((state) => (
            <MenuItem key={state} value={state}>
              {STATE_LABELS[state]}
            </MenuItem>
          ))}
        </Select>
        {error !== undefined && <FormHelperText>{error}</FormHelperText>}
      </FormControl>

      {pending && (
        <TextField
          type="datetime-local"
          label={value === TicketState.pending_reminder ? 'Remind at' : 'Close at'}
          value={toLocalInputValue(pendingUntil)}
          onChange={handlePendingUntilChange}
          disabled={disabled}
          required
          fullWidth
          size="small"
          helperText="Staff see this ticket again at this time."
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { min: toLocalInputValue(minPendingUntil) || undefined },
          }}
        />
      )}
    </Box>
  );
}
