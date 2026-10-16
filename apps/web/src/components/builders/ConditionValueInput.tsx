import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';

import {
  DURATION_UNITS,
  ME,
  NOW_LITERAL,
  UNASSIGNED,
  UNGROUPED,
  fromLocalInput,
  formatDuration,
  isDateField,
  parseDuration,
  toLocalInput,
  valueList,
  type DurationUnit,
  type FilterLookups,
  type LookupOption,
} from './filter-model';

import type { Condition } from '../../api/generated/model';

/**
 * The value editor of one condition row. The control depends on the field: a multi-select over
 * fixed choices (state, priority, waiting on), over the caller's lookups (group, owner, customer,
 * tags), an amount and unit for "within the last", a Now / date-and-time choice for before and
 * after, or free text for SLA status. All of them are derived from `condition.value`, so a row
 * needs no local state of its own.
 */

export interface ConditionValueInputProps {
  condition: Condition;
  lookups: FilterLookups;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  error?: string;
}

const STATE_OPTIONS: readonly LookupOption[] = [
  { id: 'new', name: 'New' },
  { id: 'open', name: 'Open' },
  { id: 'pending_reminder', name: 'Pending (reminder)' },
  { id: 'pending_close', name: 'Pending (auto-close)' },
  { id: 'resolved', name: 'Resolved' },
  { id: 'closed', name: 'Closed' },
];

const PRIORITY_OPTIONS: readonly LookupOption[] = [
  { id: 'low', name: 'Low' },
  { id: 'normal', name: 'Normal' },
  { id: 'high', name: 'High' },
  { id: 'urgent', name: 'Urgent' },
];

const WAITING_ON_OPTIONS: readonly LookupOption[] = [
  { id: 'support', name: 'Support' },
  { id: 'customer', name: 'Customer' },
];

export interface OptionPickerProps {
  label: string;
  options: readonly LookupOption[];
  ids: readonly string[];
  onChange: (ids: string[]) => void;
  unknownLabel: string;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onInputChange?: (query: string) => void;
  noOptionsText?: string;
}

export function OptionPicker({ label, options, ids, onChange, unknownLabel, disabled, loading, error, onInputChange, noOptionsText }: OptionPickerProps) {
  const byId = new Map(options.map((option) => [option.id, option]));
  const selected = ids.map((id) => byId.get(id) ?? { id, name: `${unknownLabel} (${id.slice(0, 8)})` });
  return (
    <Autocomplete<LookupOption, true>
      multiple
      size="small"
      fullWidth
      disableCloseOnSelect
      filterSelectedOptions
      disabled={disabled}
      loading={loading}
      options={[...options]}
      value={selected}
      getOptionLabel={(option) => option.name}
      isOptionEqualToValue={(option, chosen) => option.id === chosen.id}
      onChange={(_event, next) => onChange(next.map((option) => option.id))}
      onInputChange={onInputChange === undefined ? undefined : (_event, query, reason) => reason === 'input' && onInputChange(query)}
      noOptionsText={noOptionsText ?? 'No matches'}
      loadingText="Loading…"
      renderInput={(params) => <TextField {...params} label={label} error={error !== undefined} helperText={error} />}
    />
  );
}

export function ConditionValueInput({ condition, lookups, onChange, disabled = false, error }: ConditionValueInputProps) {
  const { field, operator, value } = condition;
  const loading = lookups.status === 'loading';

  if (isDateField(field)) {
    if (operator === 'within_last') {
      const parsed = parseDuration(value) ?? { amount: 0, unit: 'days' as DurationUnit };
      return (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <TextField
            label="Amount"
            type="number"
            size="small"
            disabled={disabled}
            value={parsed.amount === 0 ? '' : String(parsed.amount)}
            onChange={(event) => {
              const amount = Math.floor(Number(event.target.value));
              onChange(formatDuration(Number.isFinite(amount) && amount > 0 ? amount : 0, parsed.unit));
            }}
            error={error !== undefined}
            helperText={error}
            slotProps={{ htmlInput: { min: 1, step: 1 } }}
            sx={{ width: 110 }}
          />
          <TextField
            select
            label="Unit"
            size="small"
            disabled={disabled}
            value={parsed.unit}
            onChange={(event) => onChange(formatDuration(parsed.amount, event.target.value as DurationUnit))}
            sx={{ minWidth: 120 }}
          >
            {DURATION_UNITS.map((unit) => (
              <MenuItem key={unit.value} value={unit.value}>
                {unit.label}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      );
    }
    const isNow = value === NOW_LITERAL;
    return (
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField
          select
          label="When"
          size="small"
          disabled={disabled}
          value={isNow ? 'now' : 'date'}
          onChange={(event) => onChange(event.target.value === 'now' ? NOW_LITERAL : new Date().toISOString())}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="now">Now</MenuItem>
          <MenuItem value="date">A date and time</MenuItem>
        </TextField>
        {!isNow && (
          <TextField
            type="datetime-local"
            label="Date and time"
            size="small"
            disabled={disabled}
            value={toLocalInput(value)}
            onChange={(event) => onChange(fromLocalInput(event.target.value))}
            error={error !== undefined}
            helperText={error}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
      </Box>
    );
  }

  if (field === 'sla_status') {
    return (
      <TextField
        label="Value"
        size="small"
        fullWidth
        disabled={disabled}
        value={valueList(value).join(', ')}
        onChange={(event) => onChange(event.target.value)}
        error={error !== undefined}
        helperText={error ?? 'Matches nothing until SLA policies are in use.'}
      />
    );
  }

  const ids = valueList(value);
  switch (field) {
    case 'state':
      return <OptionPicker label="Value" options={STATE_OPTIONS} ids={ids} onChange={onChange} unknownLabel="Unknown state" disabled={disabled} error={error} />;
    case 'priority':
      return <OptionPicker label="Value" options={PRIORITY_OPTIONS} ids={ids} onChange={onChange} unknownLabel="Unknown priority" disabled={disabled} error={error} />;
    case 'waiting_on':
      return <OptionPicker label="Value" options={WAITING_ON_OPTIONS} ids={ids} onChange={onChange} unknownLabel="Unknown" disabled={disabled} error={error} />;
    case 'group':
      return (
        <OptionPicker
          label="Value"
          options={[{ id: UNGROUPED, name: 'Ungrouped' }, ...lookups.groups]}
          ids={ids}
          onChange={onChange}
          unknownLabel="Unknown group"
          disabled={disabled}
          loading={loading}
          error={error}
          noOptionsText="No matching groups"
        />
      );
    case 'owner':
      return (
        <OptionPicker
          label="Value"
          options={[...(lookups.allowMe === false ? [] : [{ id: ME, name: 'Me' }]), { id: UNASSIGNED, name: 'Unassigned' }, ...lookups.users]}
          ids={ids}
          onChange={onChange}
          unknownLabel="Unknown person"
          disabled={disabled}
          loading={loading}
          error={error}
          noOptionsText="No matching people"
        />
      );
    case 'tags':
      return (
        <OptionPicker
          label="Value"
          options={lookups.tags}
          ids={ids}
          onChange={onChange}
          unknownLabel="Unknown tag"
          disabled={disabled}
          loading={loading}
          error={error}
          noOptionsText="No matching tags"
        />
      );
    case 'customer':
      return (
        <OptionPicker
          label="Value"
          options={lookups.customers ?? []}
          ids={ids}
          onChange={onChange}
          unknownLabel="Unknown customer"
          disabled={disabled}
          loading={loading}
          error={error}
          onInputChange={lookups.onCustomerSearch}
          noOptionsText="Type to search customers"
        />
      );
    case 'created_at':
    case 'updated_at':
    case 'last_customer_message_at':
    case 'pending_until':
      // Handled above; listed so a new field forces a decision here.
      return null;
  }
}
