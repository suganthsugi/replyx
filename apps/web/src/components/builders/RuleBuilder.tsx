import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, type ReactNode, type Ref } from 'react';

import { OptionPicker } from './ConditionValueInput';
import { fieldIssue, type RuleConfig, type RuleFieldConfig, type RuleFormValue, type RuleIssues, type RuleLookups, type RuleOption } from './rule-model';

/**
 * A controlled "name + conditions + actions" form (routing rules now, automation rules later).
 * The fields come from `config`; the pickers' choices come from `lookups`, keyed by each field's
 * `lookup`. It fetches nothing and saves nothing: the caller owns `value`, validation (`issues`,
 * keyed like the API paths: `name`, `conditions`, `actions.groupId`, `actions.tagIds.2`) and the
 * Save / Cancel buttons.
 */

export interface RuleBuilderProps {
  config: RuleConfig;
  value: RuleFormValue;
  onChange: (next: RuleFormValue) => void;
  lookups: RuleLookups;
  /** The pickers show progress while their lists load. */
  lookupsLoading?: boolean;
  issues?: RuleIssues;
  disabled?: boolean;
  /** For the caller to focus the name on open. */
  nameRef?: Ref<HTMLInputElement>;
}

export function RuleBuilder({ config, value, onChange, lookups, lookupsLoading = false, issues, disabled = false, nameRef }: RuleBuilderProps) {
  const idBase = useId();
  const nameError = issues?.name;
  const conditionsError = issues?.conditions;

  const setField = (section: 'conditions' | 'actions', key: string, next: string[]) =>
    onChange({ ...value, [section]: { ...value[section], [key]: next } });

  const renderField = (section: 'conditions' | 'actions', field: RuleFieldConfig) => {
    const values = value[section][field.key] ?? [];
    const error = fieldIssue(issues, section, field.key);
    const options = field.options ?? (field.lookup === undefined ? [] : (lookups[field.lookup] ?? []));
    const id = `${idBase}-${section}-${field.key}`;
    switch (field.kind) {
      case 'phrases':
        return (
          <PhraseInput
            key={field.key}
            id={id}
            field={field}
            values={values}
            onChange={(next) => setField(section, field.key, next)}
            disabled={disabled}
            error={error}
          />
        );
      case 'multi':
        return (
          <Box key={field.key} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <OptionPicker
              label={field.label}
              options={options}
              ids={values}
              onChange={(next) => setField(section, field.key, field.maxItems === undefined ? next : next.slice(0, field.maxItems))}
              unknownLabel={field.unknownLabel ?? 'Unknown'}
              disabled={disabled}
              loading={lookupsLoading}
              error={error}
              noOptionsText={field.noOptionsText}
            />
            {field.description !== undefined && error === undefined && <FieldHint>{field.description}</FieldHint>}
          </Box>
        );
      case 'single':
        return (
          <SingleSelect
            key={field.key}
            id={id}
            field={field}
            options={options}
            value={values[0]}
            onChange={(next) => setField(section, field.key, next === undefined ? [] : [next])}
            disabled={disabled}
            loading={lookupsLoading}
            error={error}
          />
        );
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Section title="Details">
        <TextField
          label="Name"
          required
          fullWidth
          size="small"
          inputRef={nameRef}
          value={value.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          error={nameError !== undefined}
          helperText={nameError ?? `${value.name.length}/${config.maxNameLength}`}
          slotProps={{ htmlInput: { maxLength: config.maxNameLength } }}
        />
        <FormControlLabel
          control={<Switch checked={value.enabled} disabled={disabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />}
          label={value.enabled ? 'Enabled' : 'Disabled: skipped when tickets are routed'}
        />
      </Section>

      <Section title={config.conditions.title} description={config.conditions.description}>
        {conditionsError !== undefined && (
          <Typography variant="body2" color="error">
            {conditionsError}
          </Typography>
        )}
        {config.conditions.fields.map((field) => renderField('conditions', field))}
      </Section>

      <Section title={config.actions.title} description={config.actions.description}>
        {config.actions.fields.map((field) => renderField('actions', field))}
      </Section>
    </Box>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography component="h3" variant="overline" color="text.secondary">
          {title}
        </Typography>
        {description !== undefined && (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

function FieldHint({ children }: { children: ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary">
      {children}
    </Typography>
  );
}

/** Free-text chips: Enter, comma-free typing, or leaving the field adds the typed entry. */
function PhraseInput({
  id,
  field,
  values,
  onChange,
  disabled,
  error,
}: {
  id: string;
  field: RuleFieldConfig;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const normalize = field.normalize ?? ((raw: string) => raw.trim());
  return (
    <Autocomplete<string, true, false, true>
      multiple
      freeSolo
      autoSelect
      id={id}
      size="small"
      fullWidth
      disabled={disabled}
      options={[]}
      value={values}
      forcePopupIcon={false}
      onChange={(_event, next) => {
        const cleaned: string[] = [];
        for (const entry of next) {
          const item = normalize(entry);
          if (item !== '' && !cleaned.includes(item)) cleaned.push(item);
        }
        onChange(field.maxItems === undefined ? cleaned : cleaned.slice(0, field.maxItems));
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={field.label}
          error={error !== undefined}
          helperText={error ?? field.description}
        />
      )}
    />
  );
}

function SingleSelect({
  id,
  field,
  options,
  value,
  onChange,
  disabled,
  loading,
  error,
}: {
  id: string;
  field: RuleFieldConfig;
  options: readonly RuleOption[];
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  disabled: boolean;
  loading: boolean;
  error: string | undefined;
}) {
  // A chosen id the list no longer has (a deleted group) stays visible so it can be replaced.
  const known = value === undefined || options.some((option) => option.id === value);
  const shown: readonly RuleOption[] = known ? options : [...options, { id: value, name: field.unknownLabel ?? 'Unknown', disabled: true }];
  return (
    <TextField
      select
      id={id}
      label={field.label}
      required={field.required}
      size="small"
      fullWidth
      disabled={disabled}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      error={error !== undefined}
      helperText={error ?? (loading ? 'Loading…' : field.description)}
      slotProps={{ select: { displayEmpty: field.required !== true } }}
    >
      {field.required !== true && (
        <MenuItem value="">
          <em>None</em>
        </MenuItem>
      )}
      {shown.map((option) => (
        <MenuItem key={option.id} value={option.id} disabled={option.disabled === true}>
          {option.name}
        </MenuItem>
      ))}
    </TextField>
  );
}
