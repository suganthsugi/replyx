import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

import { useMe } from '../../data/auth';
import { mapViewSubmitError, usePreviewViewCount, useCreateView, useUpdateView, useViewBuilderLookups } from '../../data/view-builder';
import { useAnnounce } from '../foundations/LiveRegion';
import { ConfirmationDialog } from '../shell/ConfirmationDialog';
import { Drawer } from '../shell/Drawer';
import { useToast } from '../shell/Toast';

import { OptionPicker } from './ConditionValueInput';
import { isTreeComplete, type FilterLookups } from './filter-model';
import { FilterBuilder } from './FilterBuilder';
import { OrderedList } from './OrderedList';
import {
  COLUMN_OPTIONS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SORT_ITEMS,
  SORT_FIELDS,
  columnLabel,
  initialFormState,
  sortLabel,
  toViewInput,
  type ViewFormState,
} from './view-model';

import type { View, ViewInputColumnsItem, ViewInputSortItem, ViewInputVisibility } from '../../api/generated/model';

/**
 * The view builder drawer (FR-070–FR-077, US10): name and description, who the view is shared
 * with, the condition tree, sort order, columns and a live count of the tickets the conditions
 * match. It creates a view, or edits `view` when given. Staff only.
 *
 * The drawer fetches its own pickers and saves through the `data/view-builder` hooks; the caller
 * only decides when it is open. Focus goes to the name field on open and returns to the opener on
 * close (MUI), Escape closes it (asking first when there are unsaved changes), and the preview
 * count and save failures are announced. Render it inside the workspace `DesignSystemScope`.
 */

export interface ViewBuilderProps {
  open: boolean;
  onClose: () => void;
  /** The view to edit; omit to create one. */
  view?: View;
  /** Called with the saved view, just before `onClose`. */
  onSaved?: (view: View) => void;
  /** Whether the person may share views (`view.share`). Default: read from their permissions. */
  canShare?: boolean;
}

const PREVIEW_DELAY_MS = 400;
const KNOWN_ERROR_PREFIXES = ['name', 'description', 'visibility', 'sharedRoleIds', 'sharedGroupIds', 'conditions', 'sort', 'columns'];

const VISIBILITY_OPTIONS: readonly { value: ViewInputVisibility; label: string; hint: string }[] = [
  { value: 'personal', label: 'Only me', hint: 'Only you see this view.' },
  { value: 'all_staff', label: 'All staff', hint: 'Everyone on your team sees it.' },
  { value: 'roles', label: 'Specific roles', hint: 'People who hold one of the roles you choose.' },
  { value: 'groups', label: 'Specific groups', hint: 'People with access to one of the groups you choose.' },
];

export function ViewBuilder({ open, onClose, view, onSaved, canShare }: ViewBuilderProps) {
  const guard = useRef<(() => void) | null>(null);
  return (
    <Drawer open={open} onClose={() => (guard.current === null ? onClose() : guard.current())} title={view === undefined ? 'New view' : 'Edit view'} width={680}>
      {/* Mounted only while the drawer is open, so every opening starts from `view` afresh. */}
      <ViewBuilderBody view={view} canShare={canShare} onClose={onClose} onSaved={onSaved} guard={guard} />
    </Drawer>
  );
}

function ViewBuilderBody({
  view,
  canShare: canShareProp,
  onClose,
  onSaved,
  guard,
}: Omit<ViewBuilderProps, 'open'> & { guard: MutableRefObject<(() => void) | null> }) {
  const announce = useAnnounce();
  const toast = useToast();
  const idBase = useId();
  const me = useMe();
  const canShare = canShareProp ?? me.data?.permissions.includes('view.share') ?? false;
  const createView = useCreateView();
  const updateView = useUpdateView();
  const lookups = useViewBuilderLookups({ canShare });

  const initial = useMemo(() => initialFormState(view), [view]);
  const [state, setState] = useState<ViewFormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showIncomplete, setShowIncomplete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusInvalid = useRef(false);

  // Focus the name field on open. `autoFocus` is not enough: it fires once at mount, but MUI's
  // focus trap (an ancestor, so its effect runs after this one) restores focus to the opener and
  // then moves it to the dialog panel whenever effects are replayed (React StrictMode in dev), and
  // only leaves focus alone when it is already inside the panel. Focusing from an effect runs
  // again on every replay, ahead of the trap. On close the trap returns focus to the opener.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const patch = (next: Partial<ViewFormState>) => setState((current) => ({ ...current, ...next }));
  const dirty = JSON.stringify(toViewInput(state)) !== JSON.stringify(toViewInput(initial));
  const readOnly = view !== undefined && !view.editable;
  const inputsDisabled = saving || readOnly;

  // Escape, the backdrop and the header's Close button all come through the drawer's onClose.
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

  // After a failed validation the first invalid control gets focus once it renders as invalid.
  useEffect(() => {
    if (!focusInvalid.current) return;
    focusInvalid.current = false;
    bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });

  // ---- live preview -------------------------------------------------------------------------
  const complete = isTreeComplete(state.conditions);
  const preview = usePreviewViewCount({ enabled: complete });
  const requestPreview = preview.request;
  useEffect(() => {
    if (!complete) return;
    const timer = window.setTimeout(() => requestPreview(state.conditions), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [complete, state.conditions, requestPreview]);

  const announcedCount = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (preview.status !== 'ready' || preview.count === undefined || preview.count === announcedCount.current) return;
    announcedCount.current = preview.count;
    announce(`${preview.count} ${preview.count === 1 ? 'ticket matches' : 'tickets match'} these conditions.`);
  }, [preview.status, preview.count, announce]);

  // ---- pickers ------------------------------------------------------------------------------
  const filterLookups: FilterLookups = useMemo(
    () => ({
      groups: lookups.groups.map(({ id, name }) => ({ id, name })),
      users: lookups.owners.map(({ id, name }) => ({ id, name })),
      tags: lookups.tags.map(({ id, name }) => ({ id, name })),
      status: lookups.isLoading ? 'loading' : lookups.isError ? 'error' : 'ready',
    }),
    [lookups.groups, lookups.owners, lookups.tags, lookups.isLoading, lookups.isError],
  );
  const roleOptions = useMemo(() => lookups.roles.map(({ id, name }) => ({ id, name })), [lookups.roles]);
  const groupOptions = filterLookups.groups;

  useEffect(() => {
    if (lookups.isError) announce("Couldn't load some of the lists for sharing and conditions. Use Retry to load them again.", 'assertive');
  }, [lookups.isError, announce]);

  // ---- save ---------------------------------------------------------------------------------
  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (state.name.trim() === '') found.name = 'Enter a name for the view.';
    if (state.visibility === 'roles' && state.roleIds.length === 0) found.sharedRoleIds = 'Choose at least one role.';
    if (state.visibility === 'groups' && state.groupIds.length === 0) found.sharedGroupIds = 'Choose at least one group.';
    if (state.columns.length === 0) found.columns = 'Choose at least one column.';
    return found;
  };

  const submit = async () => {
    if (saving || readOnly) return;
    const found = validate();
    if (Object.keys(found).length > 0 || !complete) {
      setErrors(found);
      setShowIncomplete(true);
      focusInvalid.current = true;
      const problems = Object.values(found);
      if (!complete) problems.push('Every condition needs a value.');
      announce(`The view was not saved. ${problems.join(' ')}`, 'assertive');
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const input = toViewInput(state);
      const saved = view === undefined ? await createView.mutateAsync(input) : await updateView.mutateAsync({ id: view.id, ...input });
      toast({ message: view === undefined ? `View "${saved.name}" created.` : `View "${saved.name}" saved.`, severity: 'success' });
      onSaved?.(saved);
      onClose();
    } catch (caught) {
      const mapped = mapViewSubmitError(caught);
      setErrors(mapped);
      setShowIncomplete(true);
      focusInvalid.current = true;
      announce(`The view was not saved. ${Object.values(mapped).join(' ')}`, 'assertive');
      setSaving(false);
    }
  };

  const errorFor = (path: string): string | undefined => errors[path] ?? errors[`${path}.0`];
  const formErrors = Object.entries(errors)
    .filter(([path]) => path === '' || !KNOWN_ERROR_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
    .map(([, message]) => message);

  // ---- sort and columns ---------------------------------------------------------------------
  const usedSort = new Set(state.sort.map((item) => item.field));
  const unusedSort = SORT_FIELDS.filter((option) => !usedSort.has(option.value));
  const usedColumns = new Set<string>(state.columns);
  const unusedColumns = COLUMN_OPTIONS.filter((option) => !usedColumns.has(option.value));
  const addSortId = `${idBase}-add-sort`;
  const addColumnId = `${idBase}-add-column`;
  const focusById = (id: string) => window.setTimeout(() => document.getElementById(id)?.focus(), 0);

  const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    return next;
  };

  // ---- sharing ------------------------------------------------------------------------------
  const sharingLocked = !canShare || (view?.system !== undefined && view.system !== null);
  const visibilityOptions = VISIBILITY_OPTIONS.filter((option) => canShare || option.value === state.visibility || option.value === 'personal');
  const visibilityHint = VISIBILITY_OPTIONS.find((option) => option.value === state.visibility)?.hint;

  const nameId = `${idBase}-name`;

  return (
    <Box
      ref={bodyRef}
      component="form"
      noValidate
      aria-label={view === undefined ? 'New view' : `Edit view ${view.name}`}
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {readOnly && <Alert severity="info">You can look at this view but not change it.</Alert>}
      {formErrors.length > 0 && (
        <Alert severity="error">
          {formErrors.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </Alert>
      )}

      {lookups.isError && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => lookups.refetch()}>
              Retry
            </Button>
          }
        >
          Couldn&apos;t load some of the lists for sharing and conditions (roles, groups, people or tags). You can keep editing, but those pickers may be incomplete.
        </Alert>
      )}
      <Section title="Details">
        <TextField
          id={nameId}
          label="Name"
          required
          inputRef={nameRef}
          fullWidth
          size="small"
          value={state.name}
          disabled={inputsDisabled}
          onChange={(event) => patch({ name: event.target.value })}
          error={errorFor('name') !== undefined}
          helperText={errorFor('name') ?? `${state.name.length}/${MAX_NAME_LENGTH}`}
          slotProps={{ htmlInput: { maxLength: MAX_NAME_LENGTH } }}
        />
        <TextField
          label="Description"
          fullWidth
          size="small"
          multiline
          minRows={2}
          value={state.description}
          disabled={inputsDisabled}
          onChange={(event) => patch({ description: event.target.value })}
          error={errorFor('description') !== undefined}
          helperText={errorFor('description') ?? 'Optional. Shown to the people the view is shared with.'}
          slotProps={{ htmlInput: { maxLength: MAX_DESCRIPTION_LENGTH } }}
        />
      </Section>

      <Section title="Sharing">
        <FormControl component="fieldset" disabled={inputsDisabled || sharingLocked} error={errorFor('visibility') !== undefined}>
          <FormLabel component="legend" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Who can use this view
          </FormLabel>
          <RadioGroup
            row
            value={state.visibility}
            onChange={(event) => patch({ visibility: event.target.value as ViewInputVisibility })}
            aria-label="Who can use this view"
          >
            {visibilityOptions.map((option) => (
              <FormControlLabel key={option.value} value={option.value} control={<Radio size="small" />} label={option.label} />
            ))}
          </RadioGroup>
          <FormHelperText>
            {errorFor('visibility') ??
              (view?.system !== undefined && view.system !== null
                ? 'A default view is shared with everyone who can use it. Its sharing cannot change.'
                : !canShare
                  ? "You don't have permission to share views, so this view stays personal."
                  : visibilityHint)}
          </FormHelperText>
        </FormControl>
        {state.visibility === 'roles' && (
          <OptionPicker
            label="Roles"
            options={roleOptions}
            ids={state.roleIds}
            onChange={(roleIds) => patch({ roleIds })}
            unknownLabel="Unknown role"
            disabled={inputsDisabled || sharingLocked}
            loading={lookups.isLoading}
            error={errorFor('sharedRoleIds')}
            noOptionsText="No roles available"
          />
        )}
        {state.visibility === 'groups' && (
          <OptionPicker
            label="Groups"
            options={groupOptions}
            ids={state.groupIds}
            onChange={(groupIds) => patch({ groupIds })}
            unknownLabel="Unknown group"
            disabled={inputsDisabled || sharingLocked}
            loading={lookups.isLoading}
            error={errorFor('sharedGroupIds')}
            noOptionsText="No groups available"
          />
        )}
      </Section>

      <Section title="Conditions" description="A ticket is in this view when it matches the conditions below.">
        <FilterBuilder
          value={state.conditions}
          onChange={(conditions) => patch({ conditions })}
          lookups={filterLookups}
          disabled={inputsDisabled}
          errors={errors}
          showIncomplete={showIncomplete}
        />
      </Section>

      <Section title="Sort order" description={`Up to ${MAX_SORT_ITEMS} fields; earlier ones win.`}>
        <OrderedList<ViewInputSortItem>
          label="Sort order"
          noun="sort field"
          items={state.sort}
          getKey={(item) => item.field}
          getLabel={(item) => sortLabel(item.field)}
          emptyText="No sort order set."
          disabled={inputsDisabled}
          onMove={(from, to) => patch({ sort: move(state.sort, from, to) })}
          onRemove={(index) => patch({ sort: state.sort.filter((_, i) => i !== index) })}
          onEmptied={() => focusById(addSortId)}
          renderItem={(item) => (
            <>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 120 }}>
                {sortLabel(item.field)}
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={item.direction}
                disabled={inputsDisabled}
                aria-label={`${sortLabel(item.field)} direction`}
                onChange={(_event, direction: 'asc' | 'desc' | null) => {
                  if (direction !== null) patch({ sort: state.sort.map((entry) => (entry.field === item.field ? { ...entry, direction } : entry)) });
                }}
              >
                <ToggleButton value="asc">Ascending</ToggleButton>
                <ToggleButton value="desc">Descending</ToggleButton>
              </ToggleButtonGroup>
            </>
          )}
        />
        {state.sort.length < MAX_SORT_ITEMS && unusedSort.length > 0 && (
          <TextField
            select
            id={addSortId}
            label="Add a sort field"
            size="small"
            value=""
            disabled={inputsDisabled}
            onChange={(event) => {
              const field = event.target.value as ViewInputSortItem['field'];
              patch({ sort: [...state.sort, { field, direction: 'desc' }] });
              announce(`${sortLabel(field)} added to the sort order.`);
            }}
            error={errorFor('sort') !== undefined}
            helperText={errorFor('sort')}
            sx={{ maxWidth: 280 }}
          >
            {unusedSort.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Section>

      <Section title="Columns" description="Shown in this order in the ticket list.">
        <OrderedList<ViewInputColumnsItem>
          label="Columns"
          noun="column"
          items={state.columns}
          getKey={(item) => item}
          getLabel={columnLabel}
          emptyText="No columns chosen."
          disabled={inputsDisabled}
          onMove={(from, to) => patch({ columns: move(state.columns, from, to) })}
          onRemove={(index) => patch({ columns: state.columns.filter((_, i) => i !== index) })}
          onEmptied={() => focusById(addColumnId)}
        />
        {unusedColumns.length > 0 && (
          <TextField
            select
            id={addColumnId}
            label="Add a column"
            size="small"
            value=""
            disabled={inputsDisabled}
            onChange={(event) => {
              const column = event.target.value as ViewInputColumnsItem;
              patch({ columns: [...state.columns, column] });
              announce(`${columnLabel(column)} column added.`);
            }}
            error={errorFor('columns') !== undefined}
            helperText={errorFor('columns')}
            sx={{ maxWidth: 280 }}
          >
            {unusedColumns.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        )}
        {unusedColumns.length === 0 && errorFor('columns') !== undefined && (
          <Typography variant="caption" color="error">
            {errorFor('columns')}
          </Typography>
        )}
      </Section>

      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          mx: -4,
          mb: -4,
          px: 4,
          py: 3,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 3,
          flexWrap: 'wrap',
          bgcolor: 'background.paper',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <PreviewCount status={complete ? preview.status : 'incomplete'} count={preview.count} />
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button variant="text" onClick={() => guard.current?.()} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving || readOnly}
            aria-busy={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined}
          >
            {view === undefined ? 'Create view' : 'Save changes'}
          </Button>
        </Box>
      </Box>

      <ConfirmationDialog
        open={discardOpen}
        title="Discard your changes?"
        message="The changes you made to this view haven't been saved."
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

/** The visible preview. Changes are announced by the builder, so this has no live region of its own. */
function PreviewCount({ status, count }: { status: 'idle' | 'loading' | 'ready' | 'error' | 'incomplete'; count: number | undefined }) {
  let text: string;
  if (status === 'incomplete') text = 'Give every condition a value to see how many tickets match.';
  else if (status === 'error') text = "Couldn't count matching tickets for these conditions.";
  else if (count === undefined) text = 'Counting matching tickets…';
  else text = `${count} ${count === 1 ? 'ticket matches' : 'tickets match'} now`;
  const updating = status === 'loading' && count !== undefined;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
      {status === 'loading' && <CircularProgress size={14} aria-hidden="true" />}
      <Typography variant="body2" color={status === 'error' ? 'error' : 'text.secondary'} sx={{ opacity: updating ? 0.6 : 1 }}>
        {text}
        {updating ? ' (updating…)' : ''}
      </Typography>
    </Box>
  );
}
