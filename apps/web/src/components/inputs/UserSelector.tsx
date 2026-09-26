import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';

/**
 * Picks one staff member (an owner, an approver, whoever a screen needs) from a list the caller
 * already has. A structural shape rather than the generated `UserRef`/`EligibleOwner` models, so
 * either fits without conversion (`ui-components` rule: props define the shape, hooks land later).
 * MUI `Autocomplete` supplies the combobox/listbox semantics.
 */

export interface UserOption {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export interface UserSelectorProps {
  label: string;
  value: UserOption | null;
  options: readonly UserOption[];
  onChange: (value: UserOption | null) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  helperText?: string;
  error?: string;
}

export function UserSelector({
  label,
  value,
  options,
  onChange,
  loading = false,
  disabled = false,
  placeholder,
  helperText,
  error,
}: UserSelectorProps) {
  return (
    <Autocomplete
      value={value}
      onChange={(_event, next) => onChange(next)}
      options={options}
      loading={loading}
      disabled={disabled}
      getOptionLabel={(option) => option.name}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      noOptionsText="No matching people"
      loadingText="Loading people…"
      renderInput={(params) => (
        <TextField {...params} label={label} placeholder={placeholder} error={error !== undefined} helperText={error ?? helperText} />
      )}
    />
  );
}
