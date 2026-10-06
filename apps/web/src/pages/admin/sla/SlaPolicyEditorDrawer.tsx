import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  emptySlaPolicyForm,
  formToSlaPolicyBody,
  isSlaPolicyFormEqual,
  slaIssuesFromApi,
  slaPolicyToForm,
  validateSlaPolicyForm,
  type CalendarOption,
  type SlaPolicyBody,
  type SlaPolicyFormValue,
  type SlaPolicyRecord,
} from '../../../components/builders/sla-policy-model';
import { SlaPolicyBuilder } from '../../../components/builders/SlaPolicyBuilder';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Drawer } from '../../../components/shell/Drawer';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

/**
 * The add / edit drawer for one SLA policy: `SlaPolicyBuilder` plus Save and Cancel. Closing with
 * unsaved changes asks first. A failed save keeps the drawer open, puts the API's field errors on
 * the matching fields (`name`, `conditions`, `businessHoursId`, the targets, `warningPercent`),
 * moves focus to the first invalid control and announces the problem.
 */

export interface SlaPolicyEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The policy to edit; omit to add one. */
  policy?: SlaPolicyRecord;
  calendars: readonly CalendarOption[];
  groups: readonly { id: string; name: string; disabled?: boolean }[];
  lookupsLoading: boolean;
  /** Saves (create, or replace when `id` is given); rejects with the API error. */
  onSave: (body: SlaPolicyBody, id?: string) => Promise<void>;
}

const FIELD_KEYS = ['name', 'conditions', 'businessHoursId', 'firstResponseMinutes', 'nextResponseMinutes', 'resolutionMinutes', 'warningPercent'];

export function SlaPolicyEditorDrawer({ open, onClose, policy, calendars, groups, lookupsLoading, onSave }: SlaPolicyEditorDrawerProps) {
  const guard = useRef<(() => void) | null>(null);
  return (
    <Drawer open={open} onClose={() => (guard.current === null ? onClose() : guard.current())} title={policy === undefined ? 'Add SLA policy' : 'Edit SLA policy'} width={620}>
      {/* Mounted only while open, so every opening starts from `policy` afresh. */}
      <EditorBody policy={policy} calendars={calendars} groups={groups} lookupsLoading={lookupsLoading} onSave={onSave} onClose={onClose} guard={guard} />
    </Drawer>
  );
}

function mapSaveError(caught: unknown): Record<string, string> {
  const mapped = mapError(caught);
  if (mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined) return slaIssuesFromApi(mapped.fieldErrors);
  return { '': mapped.message };
}

function EditorBody({
  policy,
  calendars,
  groups,
  lookupsLoading,
  onSave,
  onClose,
  guard,
}: Omit<SlaPolicyEditorDrawerProps, 'open'> & { guard: MutableRefObject<(() => void) | null> }) {
  const announce = useAnnounce();
  const toast = useToast();
  // Read once on open: later list refreshes must not reset what the person is typing.
  const [initial] = useState<SlaPolicyFormValue>(() =>
    policy === undefined ? emptySlaPolicyForm(calendars.length === 1 ? (calendars[0]?.id ?? '') : '') : slaPolicyToForm(policy),
  );
  const [form, setForm] = useState<SlaPolicyFormValue>(initial);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusInvalid = useRef(false);
  const dirty = !isSlaPolicyFormEqual(form, initial);

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
    announce(`The policy was not saved. ${Object.values(found).join(' ')}`, 'assertive');
  };

  const submit = async () => {
    if (saving) return;
    const found = validateSlaPolicyForm(form, calendars);
    if (Object.keys(found).length > 0) {
      fail(found);
      return;
    }
    setIssues({});
    setSaving(true);
    try {
      const body = formToSlaPolicyBody(form);
      await onSave(body, policy?.id);
      toast({ message: policy === undefined ? `Policy "${body.name}" added at the end of the list.` : `Policy "${body.name}" saved.`, severity: 'success' });
      onClose();
    } catch (caught) {
      fail(mapSaveError(caught));
      setSaving(false);
    }
  };

  const formErrors = Object.entries(issues)
    .filter(([path]) => !FIELD_KEYS.includes(path))
    .map(([, message]) => message);

  return (
    <Box
      ref={bodyRef}
      component="form"
      noValidate
      aria-label={policy === undefined ? 'Add SLA policy' : `Edit SLA policy ${policy.name}`}
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

      <SlaPolicyBuilder value={form} onChange={setForm} calendars={calendars} groups={groups} lookupsLoading={lookupsLoading} issues={issues} disabled={saving} nameRef={nameRef} />

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
          {policy === undefined ? 'Add policy' : 'Save changes'}
        </Button>
      </Box>

      <ConfirmationDialog
        open={discardOpen}
        title="Discard your changes?"
        message="The changes you made to this policy haven't been saved."
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
