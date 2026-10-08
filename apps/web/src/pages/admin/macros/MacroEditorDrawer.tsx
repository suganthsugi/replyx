import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { Drawer } from '../../../components/shell/Drawer';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';

import type { Macro, MacroActions, MacroInput } from '../../../data/macros';

/**
 * Add or edit one macro (US14, FR-068): name, reply text, the ticket changes it also makes, and who
 * can use it. Field names match the API's validation paths (`name`, `body`, `actions.state`,
 * `actions.pendingInHours`, `sharedRoleIds`, ...) so `Form` puts server errors on the right field.
 */

export interface Option {
  id: string;
  name: string;
}

export interface MacroEditorDrawerProps {
  open: boolean;
  onClose: () => void;
  macro?: Macro;
  roles: readonly Option[];
  groups: readonly Option[];
  tags: readonly Option[];
  /** Creates, or replaces when `id` is given; rejects with the API error. */
  onSave: (input: MacroInput, id?: string) => Promise<void>;
}

type Visibility = NonNullable<MacroInput['visibility']>;
type StateValue = NonNullable<MacroActions['state']> | '';
type PriorityValue = NonNullable<MacroActions['priority']> | '';

const STATES: { value: StateValue; label: string }[] = [
  { value: '', label: "Don't change" },
  { value: 'open', label: 'Open' },
  { value: 'pending_reminder', label: 'Pending (reminder)' },
  { value: 'pending_close', label: 'Pending (close)' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITIES: { value: PriorityValue; label: string }[] = [
  { value: '', label: "Don't change" },
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const VISIBILITIES: { value: Visibility; label: string }[] = [
  { value: 'all_staff', label: 'Everyone on the team' },
  { value: 'roles', label: 'People with these roles' },
  { value: 'groups', label: 'People in these groups' },
];

export function MacroEditorDrawer({ open, onClose, macro, roles, groups, tags, onSave }: MacroEditorDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title={macro === undefined ? 'Add macro' : `Edit ${macro.name}`} width={560}>
      {/* Mounted only while open, so every opening starts from `macro` afresh. */}
      {open && <EditorBody macro={macro} roles={roles} groups={groups} tags={tags} onSave={onSave} onClose={onClose} />}
    </Drawer>
  );
}

function EditorBody({ macro, roles, groups, tags, onSave, onClose }: Omit<MacroEditorDrawerProps, 'open'>) {
  const [name, setName] = useState(macro?.name ?? '');
  const [body, setBody] = useState(macro?.body ?? '');
  const [state, setState] = useState<StateValue>(macro?.actions.state ?? '');
  const [pendingInHours, setPendingInHours] = useState(String(macro?.actions.pendingInHours ?? 24));
  const [priority, setPriority] = useState<PriorityValue>(macro?.actions.priority ?? '');
  const [assignToMe, setAssignToMe] = useState(macro?.actions.assignToMe === true);
  const [tagIds, setTagIds] = useState<string[]>(macro?.actions.addTagIds ?? []);
  const [visibility, setVisibility] = useState<Visibility>((macro?.visibility) ?? 'all_staff');
  const [roleIds, setRoleIds] = useState<string[]>(macro?.sharedRoleIds ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(macro?.sharedGroupIds ?? []);

  const pending = state === 'pending_reminder' || state === 'pending_close';

  const submit = async () => {
    const actions: MacroActions = {};
    if (state !== '') actions.state = state;
    if (pending) actions.pendingInHours = Number(pendingInHours);
    if (priority !== '') actions.priority = priority;
    if (assignToMe) actions.assignToMe = true;
    if (tagIds.length > 0) actions.addTagIds = tagIds;
    await onSave(
      {
        name: name.trim(),
        body,
        actions,
        visibility,
        sharedRoleIds: visibility === 'roles' ? roleIds : [],
        sharedGroupIds: visibility === 'groups' ? groupIds : [],
      },
      macro?.id,
    );
    onClose();
  };

  return (
    <Form onSubmit={submit} label={macro === undefined ? 'Add macro' : 'Edit macro'}>
      <FormError />
      <FormField name="name" label="Name" value={name} onChange={(event) => setName(event.target.value)} required slotProps={{ htmlInput: { maxLength: 80 } }} />
      <FormField
        name="body"
        label="Reply text"
        helperText="Sent to the customer when the macro is used. Leave empty for a macro that only changes the ticket."
        value={body}
        onChange={(event) => setBody(event.target.value)}
        multiline
        minRows={4}
        slotProps={{ htmlInput: { maxLength: 10_000 } }}
      />

      <Typography component="h3" variant="h3">
        Ticket changes
      </Typography>
      <FormField name="actions.state" label="Set state" select value={state} onChange={(event) => setState(event.target.value as StateValue)}>
        {STATES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </FormField>
      {pending && (
        <FormField
          name="actions.pendingInHours"
          label="Pending for (hours)"
          type="number"
          value={pendingInHours}
          onChange={(event) => setPendingInHours(event.target.value)}
          slotProps={{ htmlInput: { min: 1, max: 8760 } }}
        />
      )}
      <FormField name="actions.priority" label="Set priority" select value={priority} onChange={(event) => setPriority(event.target.value as PriorityValue)}>
        {PRIORITIES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </FormField>
      <MultiSelect name="actions.addTagIds" label="Add tags" options={tags} value={tagIds} onChange={setTagIds} />
      <FormControlLabel control={<Checkbox checked={assignToMe} onChange={(event) => setAssignToMe(event.target.checked)} />} label="Assign the ticket to whoever uses the macro" />

      <Typography component="h3" variant="h3">
        Who can use it
      </Typography>
      <FormField name="visibility" label="Shared with" select value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)}>
        {VISIBILITIES.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </FormField>
      {visibility === 'roles' && <MultiSelect name="sharedRoleIds" label="Roles" options={roles} value={roleIds} onChange={setRoleIds} />}
      {visibility === 'groups' && <MultiSelect name="sharedGroupIds" label="Groups" options={groups} value={groupIds} onChange={setGroupIds} />}

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>Cancel</Button>
        <SubmitButton>{macro === undefined ? 'Add macro' : 'Save changes'}</SubmitButton>
      </Box>
    </Form>
  );
}

function MultiSelect({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: readonly Option[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const names = new Map(options.map((option) => [option.id, option.name]));
  return (
    <FormField
      name={name}
      label={label}
      select
      value={value}
      onChange={(event) => {
        const next = event.target.value as unknown as string[] | string;
        onChange(typeof next === 'string' ? next.split(',') : next);
      }}
      slotProps={{ select: { multiple: true, renderValue: (selected) => (selected as string[]).map((id) => names.get(id) ?? 'Removed').join(', ') } }}
    >
      {options.length === 0 ? (
        <MenuItem disabled value="">
          Nothing to choose from
        </MenuItem>
      ) : (
        options.map((option) => (
          <MenuItem key={option.id} value={option.id}>
            {option.name}
          </MenuItem>
        ))
      )}
    </FormField>
  );
}
