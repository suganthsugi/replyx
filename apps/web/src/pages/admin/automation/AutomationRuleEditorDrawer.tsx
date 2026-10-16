import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import {
  AUTOMATION_RULE_CONFIG,
  TRIGGER_EVENT_OPTIONS,
  TRIGGER_SINCE_OPTIONS,
  automationRuleToForm,
  emptyAutomationForm,
  formToAutomationInput,
  isAutomationFormEqual,
  validateAutomationExtras,
  type AutomationFormValue,
  type AutomationTriggerForm,
} from '../../../components/builders/automation-rule-model';
import { DURATION_UNITS, type DurationUnit } from '../../../components/builders/filter-model';
import { FilterBuilder, type FilterLookups } from '../../../components/builders/FilterBuilder';
import { ruleIssueMessage, validateRuleForm, type RuleLookups } from '../../../components/builders/rule-model';
import { RuleBuilder, RuleBuilderSection } from '../../../components/builders/RuleBuilder';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Drawer } from '../../../components/shell/Drawer';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import type { AutomationRule, AutomationRuleInput, AutomationTriggerEvent, AutomationTriggerSince } from '../../../api/generated/model';

/**
 * The add / edit drawer for one automation rule (US17): `RuleBuilder` with a trigger section before
 * the conditions and `FilterBuilder` (or "every ticket") as the conditions. Closing with unsaved
 * changes asks first; a failed save keeps the drawer open, puts the API's field errors on the
 * matching fields (`trigger.after`, `conditions.items.0.value`, `actions.ownerId`), focuses the
 * first invalid control and announces the problem.
 */

export interface AutomationRuleEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The rule to edit; omit to add one. */
  rule?: AutomationRule;
  /** `groups`, `owners` and `tags` for the action pickers. */
  lookups: RuleLookups;
  filterLookups: FilterLookups;
  lookupsLoading: boolean;
  /** Creates, or replaces when `id` is given; rejects with the API error. */
  onSave: (input: AutomationRuleInput, id?: string) => Promise<void>;
}

const FIELD_PREFIXES = ['name', 'enabled', 'trigger', 'conditions', 'actions'];

export function AutomationRuleEditorDrawer({ open, onClose, rule, ...rest }: AutomationRuleEditorDrawerProps) {
  const guard = useRef<(() => void) | null>(null);
  return (
    <Drawer
      open={open}
      onClose={() => (guard.current === null ? onClose() : guard.current())}
      title={rule === undefined ? 'Add automation rule' : 'Edit automation rule'}
      width={680}
    >
      {/* Mounted only while open, so every opening starts from `rule` afresh. */}
      <EditorBody rule={rule} onClose={onClose} guard={guard} {...rest} />
    </Drawer>
  );
}

function mapSaveError(caught: unknown): Record<string, string> {
  const mapped = mapError(caught);
  if (mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined) {
    return Object.fromEntries(Object.entries(mapped.fieldErrors).map(([path, issue]) => [path, ruleIssueMessage(issue)]));
  }
  return { '': mapped.message };
}

function EditorBody({
  rule,
  lookups,
  filterLookups,
  lookupsLoading,
  onSave,
  onClose,
  guard,
}: Omit<AutomationRuleEditorDrawerProps, 'open'> & { guard: MutableRefObject<(() => void) | null> }) {
  const announce = useAnnounce();
  const toast = useToast();
  const initial = useMemo<AutomationFormValue>(() => (rule === undefined ? emptyAutomationForm() : automationRuleToForm(rule)), [rule]);
  const [form, setForm] = useState<AutomationFormValue>(initial);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusInvalid = useRef(false);
  const dirty = !isAutomationFormEqual(form, initial);

  // An effect, not `autoFocus`, so it survives StrictMode replays and the drawer's focus trap.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    guard.current = () => {
      if (saving) return;
      if (dirty) setDiscardOpen(true);
      else onClose();
    };
    return () => {
      guard.current = null;
    };
  }, [guard, saving, dirty, onClose]);

  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });

  const fail = (found: Record<string, string>) => {
    setIssues(found);
    focusInvalid.current = true;
    announce(`The rule was not saved. ${[...new Set(Object.values(found))].join(' ')}`, 'assertive');
  };

  const submit = async () => {
    if (saving) return;
    setAttempted(true);
    const found = { ...validateRuleForm(AUTOMATION_RULE_CONFIG, form.rule), ...validateAutomationExtras(form) };
    if (Object.keys(found).length > 0) {
      fail(found);
      return;
    }
    setIssues({});
    setSaving(true);
    try {
      const input = formToAutomationInput(form);
      await onSave(input, rule?.id);
      toast({ message: rule === undefined ? `Rule "${input.name}" added.` : `Rule "${input.name}" saved.`, severity: 'success' });
      onClose();
    } catch (caught) {
      fail(mapSaveError(caught));
      setSaving(false);
    }
  };

  const setTrigger = (patch: Partial<AutomationTriggerForm>) => setForm((current) => ({ ...current, trigger: { ...current.trigger, ...patch } }));

  const formErrors = Object.entries(issues)
    .filter(([path]) => !FIELD_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
    .map(([, message]) => message);
  const conditionsError = issues.conditions;
  const triggerError = issues['trigger.after'] ?? issues['trigger.since'] ?? issues['trigger.event'];

  const triggerSection = (
    <RuleBuilderSection title="When" description="What starts the rule. A rule never runs because of its own changes.">
      <TextField
        select
        label="Trigger"
        size="small"
        fullWidth
        disabled={saving}
        value={form.trigger.event}
        onChange={(event) => setTrigger({ event: event.target.value as AutomationTriggerEvent })}
        error={issues['trigger.event'] !== undefined}
        helperText={issues['trigger.event']}
      >
        {TRIGGER_EVENT_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
      {form.trigger.event === 'time.elapsed' && (
        <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, minWidth: 0 }}>
          <Typography component="legend" variant="body2" sx={{ mb: 2 }}>
            Run once when a ticket has waited
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <TextField
              label="Wait"
              type="number"
              size="small"
              sx={{ width: 110 }}
              disabled={saving}
              value={form.trigger.amount}
              onChange={(event) => setTrigger({ amount: event.target.value })}
              error={issues['trigger.after'] !== undefined}
              slotProps={{ htmlInput: { min: 1, step: 1, inputMode: 'numeric', 'aria-describedby': 'automation-trigger-error' } }}
            />
            <TextField
              select
              label="Unit"
              size="small"
              sx={{ width: 130 }}
              disabled={saving}
              value={form.trigger.unit}
              onChange={(event) => setTrigger({ unit: event.target.value as DurationUnit })}
            >
              {DURATION_UNITS.map((unit) => (
                <MenuItem key={unit.value} value={unit.value}>
                  {unit.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Since"
              size="small"
              sx={{ flex: 1, minWidth: 220 }}
              disabled={saving}
              value={form.trigger.since}
              onChange={(event) => setTrigger({ since: event.target.value as AutomationTriggerSince })}
              error={issues['trigger.since'] !== undefined}
            >
              {TRIGGER_SINCE_OPTIONS.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
          </Box>
          <Typography id="automation-trigger-error" variant="caption" color={triggerError === undefined ? 'text.secondary' : 'error'} sx={{ display: 'block', mt: 1 }}>
            {triggerError ?? 'Between 5 minutes and 90 days. A new message or reply starts the wait again. Closed tickets are skipped.'}
          </Typography>
        </Box>
      )}
    </RuleBuilderSection>
  );

  const conditionsSlot = (
    <>
      <RadioGroup
        aria-label="Which tickets"
        value={form.everyTicket ? 'every' : 'matching'}
        onChange={(event) => setForm((current) => ({ ...current, everyTicket: event.target.value === 'every' }))}
      >
        <FormControlLabel value="every" control={<Radio size="small" disabled={saving} />} label="Every ticket" />
        <FormControlLabel value="matching" control={<Radio size="small" disabled={saving} />} label="Only tickets that match these conditions" />
      </RadioGroup>
      {conditionsError !== undefined && (
        <Typography variant="body2" color="error">
          {conditionsError}
        </Typography>
      )}
      {!form.everyTicket && (
        <FilterBuilder
          value={form.conditions}
          onChange={(conditions) => setForm((current) => ({ ...current, conditions }))}
          lookups={filterLookups}
          disabled={saving}
          errors={issues}
          showIncomplete={attempted}
          label="Rule conditions"
        />
      )}
    </>
  );

  // `conditions` errors are shown in the slot above, not by RuleBuilder.
  const { conditions: _shownInSlot, ...builderIssues } = issues;

  return (
    <Box
      ref={bodyRef}
      component="form"
      noValidate
      aria-label={rule === undefined ? 'Add automation rule' : `Edit automation rule ${rule.name}`}
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {formErrors.length > 0 && (
        <Alert severity="error">
          {formErrors.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </Alert>
      )}

      <RuleBuilder
        config={AUTOMATION_RULE_CONFIG}
        value={form.rule}
        onChange={(next) => setForm((current) => ({ ...current, rule: next }))}
        lookups={lookups}
        lookupsLoading={lookupsLoading}
        issues={builderIssues}
        disabled={saving}
        nameRef={nameRef}
        beforeConditions={triggerSection}
        conditionsSlot={conditionsSlot}
      />

      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mx: -4,
          mb: -4,
          px: 4,
          py: 3,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
          bgcolor: 'background.paper',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Button variant="text" onClick={() => guard.current?.()} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={saving}
          aria-busy={saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined}
        >
          {rule === undefined ? 'Add rule' : 'Save changes'}
        </Button>
      </Box>

      <ConfirmationDialog
        open={discardOpen}
        title="Discard your changes?"
        message="The changes you made to this rule haven't been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          onClose();
        }}
        onClose={() => setDiscardOpen(false)}
      />
    </Box>
  );
}
