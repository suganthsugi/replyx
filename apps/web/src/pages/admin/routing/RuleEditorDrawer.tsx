import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import {
  ROUTING_RULE_CONFIG,
  emptyRuleForm,
  formToRoutingInput,
  isRuleFormEqual,
  routingRuleToForm,
  ruleIssueMessage,
  validateRuleForm,
  type RuleFormValue,
  type RuleLookups,
} from '../../../components/builders/rule-model';
import { RuleBuilder } from '../../../components/builders/RuleBuilder';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Drawer } from '../../../components/shell/Drawer';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

import type { RoutingRule, RoutingRuleInput } from '../../../api/generated/model';

/**
 * The add / edit drawer for one routing rule: `RuleBuilder` plus Save and Cancel. Closing with
 * unsaved changes asks first. A failed save keeps the drawer open, puts the API's field errors on
 * the matching fields (`name`, `conditions`, `actions.groupId`, `actions.tagIds.N`), moves focus
 * to the first invalid control and announces the problem.
 */

export interface RuleEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The rule to edit; omit to add one. */
  rule?: RoutingRule;
  lookups: RuleLookups;
  lookupsLoading: boolean;
  /** Saves (create, or update when `id` is given); rejects with the API error. */
  onSave: (input: RoutingRuleInput, id?: string) => Promise<void>;
}

const FIELD_PREFIXES = ['name', 'conditions', 'actions', 'enabled'];

export function RuleEditorDrawer({ open, onClose, rule, lookups, lookupsLoading, onSave }: RuleEditorDrawerProps) {
  const guard = useRef<(() => void) | null>(null);
  return (
    <Drawer open={open} onClose={() => (guard.current === null ? onClose() : guard.current())} title={rule === undefined ? 'Add routing rule' : 'Edit routing rule'} width={620}>
      {/* Mounted only while open, so every opening starts from `rule` afresh. */}
      <EditorBody rule={rule} lookups={lookups} lookupsLoading={lookupsLoading} onSave={onSave} onClose={onClose} guard={guard} />
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
  lookupsLoading,
  onSave,
  onClose,
  guard,
}: Omit<RuleEditorDrawerProps, 'open'> & { guard: MutableRefObject<(() => void) | null> }) {
  const announce = useAnnounce();
  const toast = useToast();
  const initial = useMemo<RuleFormValue>(() => (rule === undefined ? emptyRuleForm(ROUTING_RULE_CONFIG) : routingRuleToForm(rule)), [rule]);
  const [form, setForm] = useState<RuleFormValue>(initial);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusInvalid = useRef(false);
  const dirty = !isRuleFormEqual(form, initial);

  // Focus the name on open (an effect, not `autoFocus`, so it survives StrictMode replays and the
  // drawer's focus trap; see ViewBuilder).
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

  // After a failed save the first invalid control gets focus once it renders as invalid.
  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });

  const fail = (found: Record<string, string>) => {
    setIssues(found);
    focusInvalid.current = true;
    announce(`The rule was not saved. ${Object.values(found).join(' ')}`, 'assertive');
  };

  const submit = async () => {
    if (saving) return;
    const found = validateRuleForm(ROUTING_RULE_CONFIG, form);
    if (Object.keys(found).length > 0) {
      fail(found);
      return;
    }
    setIssues({});
    setSaving(true);
    try {
      const input = formToRoutingInput(form);
      await onSave(input, rule?.id);
      toast({ message: rule === undefined ? `Rule "${input.name}" added at the end of the list.` : `Rule "${input.name}" saved.`, severity: 'success' });
      onClose();
    } catch (caught) {
      fail(mapSaveError(caught));
      setSaving(false);
    }
  };

  const formErrors = Object.entries(issues)
    .filter(([path]) => !FIELD_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
    .map(([, message]) => message);

  return (
    <Box
      ref={bodyRef}
      component="form"
      noValidate
      aria-label={rule === undefined ? 'Add routing rule' : `Edit routing rule ${rule.name}`}
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
        config={ROUTING_RULE_CONFIG}
        value={form}
        onChange={setForm}
        lookups={lookups}
        lookupsLoading={lookupsLoading}
        issues={issues}
        disabled={saving}
        nameRef={nameRef}
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
