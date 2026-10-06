import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import {
  defaultBusinessHours,
  toBusinessHoursInput,
  toBusinessHoursValue,
  validateBusinessHours,
  type BusinessHoursInput,
  type BusinessHoursValue,
} from '../../../components/builders/business-hours-model';
import { BusinessHoursEditor } from '../../../components/builders/BusinessHoursEditor';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Drawer } from '../../../components/shell/Drawer';
import { useToast } from '../../../components/shell/Toast';
import { mapError } from '../../../data/errors';

/**
 * The add / edit drawer for one business-hours calendar: a name plus `BusinessHoursEditor`. Closing
 * with unsaved changes asks first. A failed save keeps the drawer open and puts the API's errors on
 * the matching fields: `name` (also a name that is already taken), `timezone`, `intervals...`,
 * `holidays...`; focus moves to the first invalid control and the problem is announced.
 */

export interface BusinessHoursRecord {
  id: string;
  name: string;
  timezone: string;
  intervals: BusinessHoursInput['intervals'];
  holidays: readonly string[];
}

export type BusinessHoursBody = BusinessHoursInput & { name: string };

export interface BusinessHoursEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The calendar to edit; omit to add one. */
  calendar?: BusinessHoursRecord;
  /** Saves (create, or replace when `id` is given); rejects with the API error. */
  onSave: (body: BusinessHoursBody, id?: string) => Promise<void>;
}

const MAX_NAME_LENGTH = 80;

export function BusinessHoursEditorDrawer({ open, onClose, calendar, onSave }: BusinessHoursEditorDrawerProps) {
  const guard = useRef<(() => void) | null>(null);
  return (
    <Drawer
      open={open}
      onClose={() => (guard.current === null ? onClose() : guard.current())}
      title={calendar === undefined ? 'Add business hours' : 'Edit business hours'}
      width={760}
    >
      {/* Mounted only while open, so every opening starts from `calendar` afresh. */}
      <EditorBody calendar={calendar} onSave={onSave} onClose={onClose} guard={guard} />
    </Drawer>
  );
}

const ISSUE_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  too_long: 'This is too long.',
  too_big: 'There are too many entries.',
  invalid: 'This value is not valid.',
  invalid_type: 'This value is not valid.',
  invalid_value: 'This value is not valid.',
  invalid_format: 'This value is not valid.',
  unrecognized_key: 'This field is not supported.',
};

/** API `details` -> messages by path. `intervals` and `intervals.DAY.N` have their own wording. */
function issuesFromApi(fieldErrors: Readonly<Record<string, string>>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [path, issue] of Object.entries(fieldErrors)) {
    if (found[path] !== undefined) continue;
    if (path === 'timezone') found[path] = 'Choose a time zone from the list.';
    else if (path === 'intervals') found[path] = 'Open at least one day.';
    else if (/^intervals\.[a-z]{3}\.\d+$/.test(path)) found[path] = 'This range starts and ends at the same time. Use "24 hours" for a day that never closes.';
    else found[path] = ISSUE_MESSAGES[issue] ?? `${issue.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}.`;
  }
  return found;
}

function mapSaveError(caught: unknown): Record<string, string> {
  const mapped = mapError(caught);
  if (mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined) return issuesFromApi(mapped.fieldErrors);
  if (mapped.code === 'BUSINESS_HOURS_NAME_TAKEN') return { name: 'Another calendar already has this name. Choose a different one.' };
  return { '': mapped.message };
}

function EditorBody({
  calendar,
  onSave,
  onClose,
  guard,
}: Omit<BusinessHoursEditorDrawerProps, 'open'> & { guard: MutableRefObject<(() => void) | null> }) {
  const announce = useAnnounce();
  const toast = useToast();
  const initial = useMemo(() => ({ name: calendar?.name ?? '', hours: calendar === undefined ? defaultBusinessHours() : toBusinessHoursValue(calendar) }), [calendar]);
  const [name, setName] = useState(initial.name);
  const [hours, setHours] = useState<BusinessHoursValue>(initial.hours);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusInvalid = useRef(false);
  const dirty = name !== initial.name || JSON.stringify(hours) !== JSON.stringify(initial.hours);

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
    announce(`The calendar was not saved. ${Object.values(found).join(' ')}`, 'assertive');
  };

  const submit = async () => {
    if (saving) return;
    const found = validateBusinessHours(hours);
    if (name.trim() === '') found['name'] = 'Enter a name.';
    else if (name.trim().length > MAX_NAME_LENGTH) found['name'] = `Use ${MAX_NAME_LENGTH} characters or fewer.`;
    if (Object.keys(found).length > 0) {
      fail(found);
      return;
    }
    setIssues({});
    setSaving(true);
    try {
      const body: BusinessHoursBody = { name: name.trim(), ...toBusinessHoursInput(hours) };
      await onSave(body, calendar?.id);
      toast({ message: calendar === undefined ? `Calendar "${body.name}" added.` : `Calendar "${body.name}" saved.`, severity: 'success' });
      onClose();
    } catch (caught) {
      fail(mapSaveError(caught));
      setSaving(false);
    }
  };

  const formErrors = Object.entries(issues)
    .filter(([path]) => path === '')
    .map(([, message]) => message);
  // Issues for the schedule, by path; `name` belongs to the field above it.
  const { name: nameIssue, ...scheduleIssues } = issues;

  return (
    <Box
      ref={bodyRef}
      component="form"
      noValidate
      aria-label={calendar === undefined ? 'Add business hours' : `Edit business hours ${calendar.name}`}
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

      <TextField
        label="Name"
        required
        fullWidth
        size="small"
        inputRef={nameRef}
        value={name}
        disabled={saving}
        onChange={(event) => setName(event.target.value)}
        error={nameIssue !== undefined}
        helperText={nameIssue ?? `${name.length}/${MAX_NAME_LENGTH}`}
        slotProps={{ htmlInput: { maxLength: MAX_NAME_LENGTH } }}
      />

      <BusinessHoursEditor value={hours} onChange={setHours} disabled={saving} errors={scheduleIssues} />

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
          {calendar === undefined ? 'Add calendar' : 'Save changes'}
        </Button>
      </Box>

      <ConfirmationDialog
        open={discardOpen}
        title="Discard your changes?"
        message="The changes you made to this calendar haven't been saved."
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
