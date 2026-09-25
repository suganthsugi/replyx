import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { useCreateGroup, useDeleteGroup, useGroups, useUpdateGroup, type Group } from '../../../data/groups';

/**
 * Groups of tickets (FR-028–FR-030): create, rename, deactivate and delete. A new group is open
 * to Admin only until roles are given access in the role editor. Inactive groups keep their
 * tickets but take no new ones. A group with tickets can't be deleted: the API answers
 * `GROUP_HAS_TICKETS` and the dialog says to move the tickets first.
 */

type Pending = { kind: 'edit'; group: Group } | { kind: 'create' } | { kind: 'delete'; group: Group } | { kind: 'status'; group: Group };

export default function GroupsPage() {
  const groupsQuery = useGroups();
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const held = new Set(useMe().data?.permissions ?? []);
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const groups = groupsQuery.data ?? [];
  const close = () => setPending(null);

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1">
            Groups
          </Typography>
          {held.has('group.create') && (
            <Button variant="contained" onClick={() => setPending({ kind: 'create' })}>
              New group
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 640 }}>
          Groups sort tickets by team or topic. A new group is visible to Admin only until you give roles
          access to it on the role&apos;s page.
        </Typography>

        {groupsQuery.isPending && <Skeleton variant="list" rows={4} label="groups" />}

        {groupsQuery.isError && (
          <EmptyState variant="error" title="Couldn't load groups" message={groupsQuery.error?.message} onRetry={() => void groupsQuery.refetch()} />
        )}

        {!groupsQuery.isPending && !groupsQuery.isError && groups.length === 0 && (
          <EmptyState
            title="No groups yet"
            message="Tickets without a group are in Ungrouped. Create a group to sort them by team."
            action={held.has('group.create') ? { label: 'New group', onClick: () => setPending({ kind: 'create' }) } : undefined}
          />
        )}

        {!groupsQuery.isPending && !groupsQuery.isError && groups.length > 0 && (
          <TableContainer sx={{ position: 'relative', border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}>
            <Table aria-label="Groups" sx={{ minWidth: 560 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Open tickets</TableCell>
                  <TableCell align="right">
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {group.name}
                      </Typography>
                      {group.description !== undefined && (
                        <Typography variant="caption" color="text.secondary">
                          {group.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={group.status === 'active' ? 'Active' : 'Inactive'}
                        sx={group.status === 'active' ? { bgcolor: 'success.light', color: 'success.main' } : undefined}
                      />
                    </TableCell>
                    <TableCell align="right">{group.openTicketCount}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {held.has('group.edit') && (
                        <>
                          <Button size="small" onClick={() => setPending({ kind: 'edit', group })} aria-label={`Rename ${group.name}`}>
                            Rename
                          </Button>
                          <Button size="small" onClick={() => setPending({ kind: 'status', group })}>
                            {group.status === 'active' ? 'Deactivate' : 'Activate'}
                            <VisuallyHidden> {group.name}</VisuallyHidden>
                          </Button>
                        </>
                      )}
                      {held.has('group.delete') && (
                        <Button size="small" color="error" onClick={() => setPending({ kind: 'delete', group })} aria-label={`Delete ${group.name}`}>
                          Delete
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {(pending?.kind === 'create' || pending?.kind === 'edit') && (
          <GroupDialog group={pending.kind === 'edit' ? pending.group : undefined} onClose={close} />
        )}

        {pending?.kind === 'status' && (
          <ConfirmationDialog
            open
            title={`${pending.group.status === 'active' ? 'Deactivate' : 'Activate'} ${pending.group.name}`}
            message={
              pending.group.status === 'active'
                ? 'The group keeps its tickets, but no new or moved tickets can go into it.'
                : 'The group can take new and moved tickets again.'
            }
            confirmLabel={pending.group.status === 'active' ? 'Deactivate' : 'Activate'}
            onClose={close}
            onConfirm={async () => {
              const status = pending.group.status === 'active' ? 'inactive' : 'active';
              await updateGroup.mutateAsync({ id: pending.group.id, status });
              toast({ message: `${pending.group.name} ${status === 'active' ? 'activated' : 'deactivated'}`, severity: 'success' });
            }}
          />
        )}

        {pending?.kind === 'delete' && (
          <ConfirmationDialog
            open
            title={`Delete ${pending.group.name}`}
            message={
              pending.group.openTicketCount > 0
                ? 'This group still has tickets. Move them to another group or to Ungrouped first.'
                : 'The group and its access settings are removed for good.'
            }
            confirmLabel="Delete group"
            destructive
            onClose={close}
            onConfirm={async () => {
              await deleteGroup.mutateAsync({ id: pending.group.id });
              toast({ message: `${pending.group.name} deleted`, severity: 'success' });
            }}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}

function GroupDialog({ group, onClose }: { group: Group | undefined; onClose: () => void }) {
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup();
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const title = group === undefined ? 'New group' : `Rename ${group.name}`;

  return (
    <Modal open onClose={onClose} title={title}>
      <Form
        label={title}
        onSubmit={async () => {
          if (group === undefined) {
            const created = await createGroup.mutateAsync({
              name: name.trim(),
              ...(description.trim() === '' ? {} : { description: description.trim() }),
            });
            toast({ message: `${created.name} created. Only Admin can see it until you grant roles access.`, severity: 'success' });
          } else {
            await updateGroup.mutateAsync({ id: group.id, name: name.trim(), description: description.trim() });
            toast({ message: 'Group saved', severity: 'success' });
          }
          onClose();
        }}
      >
        <FormField name="name" label="Name" value={name} onChange={(event) => setName(event.target.value)} required slotProps={{ htmlInput: { maxLength: 80 } }} />
        <FormField
          name="description"
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          slotProps={{ htmlInput: { maxLength: 300 } }}
        />
        <FormError />
        <SubmitButton>{group === undefined ? 'Create group' : 'Save'}</SubmitButton>
      </Form>
    </Modal>
  );
}
