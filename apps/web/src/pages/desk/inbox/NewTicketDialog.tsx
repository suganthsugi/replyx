import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import { useEffect, useMemo, useState } from 'react';

import { GroupSelector, type GroupOption } from '../../../components/inputs/GroupSelector';
import { PrioritySelector } from '../../../components/inputs/PrioritySelector';
import { TagInput } from '../../../components/inputs/TagInput';
import { UserSelector, type UserOption } from '../../../components/inputs/UserSelector';
import { Form, FormField, SubmitButton, issueMessage } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { mapError } from '../../../data/errors';
import { useEligibleOwners, useGroups } from '../../../data/groups';
import { useCreateTag, useTags } from '../../../data/tags';
import { useCreateTicket, type Priority } from '../../../data/tickets';
import { useUsers } from '../../../data/users';

import type { UiError } from '../../../data/errors';
import type { TagRef } from '../../../data/tags';

/**
 * A staff-started ticket (FR-038a): an existing active customer, an active group the viewer can
 * create tickets on, an optional owner/priority/tags, a title and a first message. The message is
 * a public reply the customer will see (helper text says so), so it skips internal notes.
 */

export interface NewTicketDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (ticketId: string) => void;
}

const CONFLICT_MESSAGES: Record<string, { field: 'customer' | 'group' | 'owner'; message: string }> = {
  CUSTOMER_INACTIVE: { field: 'customer', message: 'This customer is no longer active.' },
  GROUP_INACTIVE: { field: 'group', message: 'This group is no longer active.' },
  OWNER_NOT_ELIGIBLE: { field: 'owner', message: 'This owner no longer has edit access on the group.' },
};

export function NewTicketDialog({ open, onClose, onCreated }: NewTicketDialogProps) {
  const me = useMe();
  const permissions = new Set(me.data?.permissions ?? []);
  const toast = useToast();
  const createTicket = useCreateTicket();
  const createTag = useCreateTag();

  const [customer, setCustomer] = useState<UserOption | null>(null);
  const [group, setGroup] = useState<GroupOption | null>(null);
  const [owner, setOwner] = useState<UserOption | null>(null);
  const [priority, setPriority] = useState<Priority>('normal');
  const [tags, setTags] = useState<TagRef[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [apiError, setApiError] = useState<UiError | undefined>(undefined);

  // Reset every time the dialog opens; MUI unmounts the dialog content while closed, but this
  // component (holding the state) stays mounted the whole time.
  useEffect(() => {
    if (!open) return;
    setCustomer(null);
    setGroup(null);
    setOwner(null);
    setPriority('normal');
    setTags([]);
    setTitle('');
    setMessage('');
    setApiError(undefined);
  }, [open]);

  // UserSelector has no input-change callback (only a fixed `options` list), so this loads active
  // customers once and relies on the Autocomplete's own client-side filtering as the viewer types.
  const customersQuery = useUsers({ kind: 'customer', status: 'active' });
  const customerOptions: UserOption[] = useMemo(
    () =>
      (customersQuery.data?.pages.flatMap((page) => page.items) ?? []).map((user) => ({
        id: user.id,
        name: `${user.name} (${user.email})`,
      })),
    [customersQuery.data],
  );

  const groupsQuery = useGroups('active');
  const groupAccess = me.data?.groupAccess ?? [];
  const groupOptions: GroupOption[] = (groupsQuery.data ?? [])
    .filter((candidate) => groupAccess.some((access) => access.groupId === candidate.id && access.create))
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));

  const ownersQuery = useEligibleOwners(group?.id);
  const ownerOptions: UserOption[] = (ownersQuery.data ?? []).map((eligible) => ({
    id: eligible.id,
    name: eligible.name,
    avatarUrl: eligible.avatarUrl,
  }));

  const tagsQuery = useTags();
  const tagOptions = tagsQuery.data ?? [];

  const conflict = apiError?.code !== undefined ? CONFLICT_MESSAGES[apiError.code] : undefined;
  const genericError = apiError !== undefined && conflict === undefined && apiError.fieldErrors === undefined ? apiError.message : undefined;

  const fieldIssue = (name: string): string | undefined => {
    const issue = apiError?.fieldErrors?.[name];
    return issue === undefined ? undefined : issueMessage(issue);
  };

  return (
    <Modal open={open} onClose={onClose} title="Start a new ticket" maxWidth="sm" busy={createTicket.isPending}>
      <Form
        label="Start a new ticket"
        onSubmit={async () => {
          if (customer === null || group === null) return;
          setApiError(undefined);
          try {
            const ticket = await createTicket.mutateAsync({
              customerId: customer.id,
              groupId: group.id,
              title: title.trim(),
              message: { body: message.trim() },
              priority,
              ...(owner === null ? {} : { ownerId: owner.id }),
              ...(tags.length === 0 ? {} : { tagIds: tags.map((tag) => tag.id) }),
            });
            toast({ message: 'Ticket created', severity: 'success' });
            onCreated(ticket.id);
            onClose();
          } catch (caught) {
            setApiError(mapError(caught));
            throw caught;
          }
        }}
      >
        <Stack spacing={4}>
          <UserSelector
            label="Customer"
            value={customer}
            options={customerOptions}
            onChange={(next) => {
              setCustomer(next);
              setApiError(undefined);
            }}
            loading={customersQuery.isFetching}
            placeholder="Search by name or email"
            helperText="Only active customers can start a staff ticket."
            error={conflict?.field === 'customer' ? conflict.message : (fieldIssue('customerId') ?? customersQuery.error?.message)}
          />
          <GroupSelector
            label="Group"
            value={group}
            options={groupOptions}
            onChange={(next) => {
              setGroup(next);
              setOwner(null);
              setApiError(undefined);
            }}
            loading={groupsQuery.isPending}
            helperText="Only active groups you can create tickets on are listed."
            error={conflict?.field === 'group' ? conflict.message : (fieldIssue('groupId') ?? groupsQuery.error?.message)}
          />
          <UserSelector
            label="Owner (optional)"
            value={owner}
            options={ownerOptions}
            onChange={(next) => {
              setOwner(next);
              setApiError(undefined);
            }}
            loading={ownersQuery.isFetching}
            disabled={group === null}
            helperText={group === null ? 'Choose a group first.' : 'Leave blank to keep the ticket unassigned.'}
            error={conflict?.field === 'owner' ? conflict.message : fieldIssue('ownerId')}
          />
          <PrioritySelector value={priority} onChange={setPriority} />
          <TagInput
            value={tags}
            options={tagOptions}
            onChange={setTags}
            onCreateTag={
              permissions.has('tag.create')
                ? (createdName) => {
                    void createTag.mutateAsync({ name: createdName }).then((created) => setTags((current) => [...current, created]));
                  }
                : undefined
            }
          />
          <FormField
            name="title"
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            slotProps={{ htmlInput: { maxLength: 200 } }}
          />
          <FormField
            name="message.body"
            label="First message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            required
            multiline
            minRows={4}
            helperText="This is a public reply — the customer will see it as your first message on the ticket."
            slotProps={{ htmlInput: { maxLength: 10000 } }}
          />
          {genericError !== undefined && <Alert severity="error">{genericError}</Alert>}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
            <Button onClick={onClose} disabled={createTicket.isPending}>
              Cancel
            </Button>
            <SubmitButton disabled={customer === null || group === null || title.trim() === '' || message.trim() === ''}>
              Create ticket
            </SubmitButton>
          </Box>
        </Stack>
      </Form>
    </Modal>
  );
}
