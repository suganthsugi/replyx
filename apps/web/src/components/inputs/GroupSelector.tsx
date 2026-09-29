import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';

import type { Ref } from 'react';

/**
 * Picks one group (a ticket's queue) from a list the caller already has, matching the shape of
 * the generated `GroupRef`. MUI `Autocomplete` supplies the combobox/listbox semantics.
 */

export interface GroupOption {
  id: string;
  name: string;
}

export interface GroupSelectorProps {
  label: string;
  value: GroupOption | null;
  options: readonly GroupOption[];
  onChange: (value: GroupOption | null) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  helperText?: string;
  error?: string;
  /** Lets a caller (e.g. a keyboard shortcut) focus the underlying `<input>` directly. */
  inputRef?: Ref<HTMLInputElement>;
}

export function GroupSelector({
  label,
  value,
  options,
  onChange,
  loading = false,
  disabled = false,
  placeholder,
  helperText,
  error,
  inputRef,
}: GroupSelectorProps) {
  return (
    <Autocomplete
      value={value}
      onChange={(_event, next) => onChange(next)}
      options={options}
      loading={loading}
      disabled={disabled}
      getOptionLabel={(option) => option.name}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      noOptionsText="No matching groups"
      loadingText="Loading groups…"
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          error={error !== undefined}
          helperText={error ?? helperText}
          inputRef={inputRef}
        />
      )}
    />
  );
}
