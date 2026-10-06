import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, type ReactNode, type Ref } from 'react';

import { formatDurationLong } from '../data-display/duration';

import { OptionPicker } from './ConditionValueInput';
import {
  MAX_POLICY_NAME_LENGTH,
  MAX_TARGET_MINUTES,
  MAX_WARNING_PERCENT,
  MIN_WARNING_PERCENT,
  PRIORITY_OPTIONS,
  TARGET_FIELDS,
  UNGROUPED_ID,
  type CalendarOption,
  type SlaClause,
  type SlaOperator,
  type SlaPolicyFormValue,
  type SlaPolicyIssues,
} from './sla-policy-model';

/**
 * A controlled form for one SLA policy (US12, FR-084): name, which tickets it covers (priority and
 * group clauses; an empty clause means "any"), the business-hours calendar, the three targets in
 * business minutes (blank = not tracked) and the warning threshold. It fetches and saves nothing:
 * the caller owns `value`, validation (`issues`, keyed like the API paths) and the buttons.
 */

export interface SlaPolicyBuilderProps {
  value: SlaPolicyFormValue;
  onChange: (next: SlaPolicyFormValue) => void;
  calendars: readonly CalendarOption[];
  groups: readonly { id: string; name: string; disabled?: boolean }[];
  /** The pickers show progress while their lists load. */
  lookupsLoading?: boolean;
  issues?: SlaPolicyIssues;
  disabled?: boolean;
  /** For the caller to focus the name on open. */
  nameRef?: Ref<HTMLInputElement>;
}

const OPERATOR_LABELS: Record<SlaOperator, string> = { is: 'Is any of', is_not: 'Is none of' };

export function SlaPolicyBuilder({ value, onChange, calendars, groups, lookupsLoading = false, issues, disabled = false, nameRef }: SlaPolicyBuilderProps) {
  const idBase = useId();
  const groupOptions = [{ id: UNGROUPED_ID, name: 'Ungrouped' }, ...groups];
  const set = <K extends keyof SlaPolicyFormValue>(key: K, next: SlaPolicyFormValue[K]) => onChange({ ...value, [key]: next });

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
          onChange={(event) => set('name', event.target.value)}
          error={issues?.['name'] !== undefined}
          helperText={issues?.['name'] ?? `${value.name.length}/${MAX_POLICY_NAME_LENGTH}`}
          slotProps={{ htmlInput: { maxLength: MAX_POLICY_NAME_LENGTH } }}
        />
      </Section>

      <Section
        title="Applies to"
        description="A ticket gets the first policy, from the top of the list, whose conditions match. Leave a field empty to match any value."
      >
        {issues?.['conditions'] !== undefined && (
          <Typography variant="body2" color="error">
            {issues['conditions']}
          </Typography>
        )}
        {value.foreignConditions !== null ? (
          <Alert
            severity="info"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={disabled}
                onClick={() => onChange({ ...value, foreignConditions: null, priority: { operator: 'is', values: [] }, group: { operator: 'is', values: [] } })}
              >
                Replace conditions
              </Button>
            }
          >
            This policy&apos;s conditions are more detailed than this editor can show. They stay as they are
            unless you replace them.
          </Alert>
        ) : (
          <>
            <ClauseField
              idBase={`${idBase}-priority`}
              label="Priority"
              clause={value.priority}
              onChange={(clause) => set('priority', clause)}
              options={PRIORITY_OPTIONS}
              anyText="Any priority"
              disabled={disabled}
            />
            <ClauseField
              idBase={`${idBase}-group`}
              label="Group"
              clause={value.group}
              onChange={(clause) => set('group', clause)}
              options={groupOptions}
              anyText="Any group, including tickets with none"
              disabled={disabled}
              loading={lookupsLoading}
            />
          </>
        )}
      </Section>

      <Section title="Business hours" description="Targets count only the minutes this calendar is open.">
        <TextField
          select
          label="Calendar"
          required
          fullWidth
          size="small"
          disabled={disabled}
          value={calendars.some((calendar) => calendar.id === value.businessHoursId) ? value.businessHoursId : ''}
          onChange={(event) => set('businessHoursId', event.target.value)}
          error={issues?.['businessHoursId'] !== undefined}
          helperText={issues?.['businessHoursId'] ?? (calendars.length === 0 ? 'Add a business-hours calendar first.' : undefined)}
        >
          {calendars.map((calendar) => (
            <MenuItem key={calendar.id} value={calendar.id}>
              {calendar.name}
            </MenuItem>
          ))}
        </TextField>
      </Section>

      <Section title="Targets" description="Business minutes. Leave a target blank to not track it.">
        {TARGET_FIELDS.map(({ key, label, description }) => {
          const minutes = /^\d+$/.test(value[key].trim()) ? Number(value[key].trim()) : undefined;
          const readable = minutes !== undefined && minutes >= 1 && minutes <= MAX_TARGET_MINUTES ? `${formatDurationLong(minutes)}. ` : '';
          return (
            <TextField
              key={key}
              label={`${label} target (minutes)`}
              type="number"
              size="small"
              fullWidth
              disabled={disabled}
              value={value[key]}
              onChange={(event) => set(key, event.target.value)}
              error={issues?.[key] !== undefined}
              helperText={issues?.[key] ?? `${readable}${description}`}
              slotProps={{ htmlInput: { min: 1, max: MAX_TARGET_MINUTES, step: 1, inputMode: 'numeric' } }}
            />
          );
        })}
        <TextField
          label="Warn at (percent of target)"
          type="number"
          size="small"
          required
          fullWidth
          disabled={disabled}
          value={value.warningPercent}
          onChange={(event) => set('warningPercent', event.target.value)}
          error={issues?.['warningPercent'] !== undefined}
          helperText={issues?.['warningPercent'] ?? 'Staff see an at-risk warning, and are notified, when this much of a target has passed.'}
          slotProps={{ htmlInput: { min: MIN_WARNING_PERCENT, max: MAX_WARNING_PERCENT, step: 1, inputMode: 'numeric' } }}
        />
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

function ClauseField({
  idBase,
  label,
  clause,
  onChange,
  options,
  anyText,
  disabled,
  loading = false,
}: {
  idBase: string;
  label: string;
  clause: SlaClause;
  onChange: (next: SlaClause) => void;
  options: readonly { id: string; name: string; disabled?: boolean }[];
  anyText: string;
  disabled: boolean;
  loading?: boolean;
}) {
  const hintId = `${idBase}-hint`;
  return (
    <Box role="group" aria-labelledby={`${idBase}-label`} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography id={`${idBase}-label`} variant="subtitle2">
        {label}
      </Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label={`${label} match`}
          value={clause.operator}
          disabled={disabled}
          onChange={(event) => onChange({ ...clause, operator: event.target.value as SlaOperator })}
          sx={{ width: 160 }}
        >
          {(Object.keys(OPERATOR_LABELS) as SlaOperator[]).map((operator) => (
            <MenuItem key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </MenuItem>
          ))}
        </TextField>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <OptionPicker
            label={`${label} values`}
            options={options}
            ids={clause.values}
            onChange={(values) => onChange({ ...clause, values })}
            unknownLabel="Deleted group"
            disabled={disabled}
            loading={loading}
            noOptionsText="No matches"
          />
        </Box>
      </Box>
      {clause.values.length === 0 && (
        <Typography id={hintId} variant="caption" color="text.secondary">
          {anyText}
        </Typography>
      )}
    </Box>
  );
}

