import Autocomplete from '@mui/material/Autocomplete';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';

import type { TagRef } from '../../api/generated/model';

/**
 * The ticket's tags (docs/design-system "Tags: billing, refund"): a free-solo multi-select over
 * the tenant's existing tags (`options`). Typing text that matches no existing tag and pressing
 * Enter calls `onCreateTag`; the caller creates it and adds it to `options`/`value` once the API
 * confirms, rather than this component guessing at an id.
 */

export interface TagInputProps {
  label?: string;
  value: readonly TagRef[];
  options: readonly TagRef[];
  onChange: (next: TagRef[]) => void;
  onCreateTag?: (name: string) => void;
  disabled?: boolean;
  placeholder?: string;
  error?: string;
}

export function TagInput({ label = 'Tags', value, options, onChange, onCreateTag, disabled = false, placeholder, error }: TagInputProps) {
  return (
    <Autocomplete<TagRef, true, false, true>
      multiple
      freeSolo
      disabled={disabled}
      options={options}
      value={[...value]}
      filterSelectedOptions
      getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      onChange={(_event, next) => {
        const tags: TagRef[] = [];
        for (const item of next) {
          if (typeof item === 'string') {
            const trimmed = item.trim();
            if (trimmed === '') continue;
            const match = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
            if (match !== undefined) tags.push(match);
            else onCreateTag?.(trimmed);
          } else {
            tags.push(item);
          }
        }
        onChange(tags);
      }}
      renderTags={(tagValue, getTagProps) =>
        tagValue.map((option, index) => {
          const tag = typeof option === 'string' ? { id: option, name: option } : option;
          const { key, ...rest } = getTagProps({ index });
          return <Chip key={key} label={tag.name} size="small" {...rest} />;
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={value.length === 0 ? placeholder : undefined}
          error={error !== undefined}
          helperText={error}
        />
      )}
    />
  );
}
