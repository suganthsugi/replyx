import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import { useRoles } from '../../../data/roles';
import {
  useDeactivateUser,
  useDeleteUser,
  useEraseUser,
  useInviteUser,
  useReactivateUser,
  useUsers,
  type UserFilters,
} from '../../../data/users';

import type { ListUsersKind, Role, User, UserStatus } from '../../../api/generated/model';

type ActionType = 'deactivate' | 'reactivate' | 'delete' | 'erase';

interface PendingAction {
  type: ActionType;
  user: User;
}

function statusLabel(status: UserStatus): string {
  switch (status) {
    case 'invited':
      return 'Invited';
    case 'active':
      return 'Active';
    case 'deactivated':
      return 'Deactivated';
    default:
      return status;
  }
}

function formatLastSignIn(value: string | null | undefined): string {
  return value === null || value === undefined ? 'Never' : new Date(value).toLocaleString();
}

function actionTitle(type: ActionType): string {
  switch (type) {
    case 'deactivate':
      return 'Deactivate user';
    case 'reactivate':
      return 'Reactivate user';
    case 'delete':
      return 'Delete user';
    case 'erase':
      return 'Erase user';
  }
}

function actionConfirmLabel(type: ActionType): string {
  switch (type) {
    case 'deactivate':
      return 'Deactivate';
    case 'reactivate':
      return 'Reactivate';
    case 'delete':
      return 'Delete';
    case 'erase':
      return 'Erase';
  }
}

function actionMessage(action: PendingAction): string {
  switch (action.type) {
    case 'deactivate':
      return `${action.user.name} will no longer be able to sign in. Their history is kept.`;
    case 'reactivate':
      return `${action.user.name} will be able to sign in again.`;
    case 'delete':
      return `${action.user.name} will be removed from user lists. This can't be undone from here.`;
    case 'erase':
      return `This permanently erases ${action.user.name}'s personal data. This cannot be undone.`;
  }
}

/**
 * The admin user directory (FR-014): status, roles and last sign-in, with invite, deactivate,
 * reactivate, delete and erase actions.
 */
export default function UsersPage() {
  const [filters, setFilters] = useState<UserFilters>({});
  const usersQuery = useUsers(filters);
  const rolesQuery = useRoles();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const toast = useToast();

  const deactivateUser = useDeactivateUser();
  const reactivateUser = useReactivateUser();
  const deleteUser = useDeleteUser();
  const eraseUser = useEraseUser();

  const users = usersQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const roles = rolesQuery.data ?? [];

  const runAction = async (action: PendingAction) => {
    switch (action.type) {
      case 'deactivate':
        await deactivateUser.mutateAsync({ id: action.user.id });
        toast({ message: `${action.user.name} deactivated`, severity: 'success' });
        return;
      case 'reactivate':
        await reactivateUser.mutateAsync({ id: action.user.id });
        toast({ message: `${action.user.name} reactivated`, severity: 'success' });
        return;
      case 'delete':
        await deleteUser.mutateAsync({ id: action.user.id });
        toast({ message: `${action.user.name} deleted`, severity: 'success' });
        return;
      case 'erase':
        await eraseUser.mutateAsync({ id: action.user.id });
        toast({ message: `${action.user.name} erased`, severity: 'success' });
    }
  };

  return (
    <Box component="main" sx={{ px: { xs: 4, sm: 6 }, py: 6 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 6, flexWrap: 'wrap', gap: 3 }}>
        <Typography component="h1" variant="h4">
          Users
        </Typography>
        <Button variant="contained" onClick={() => setInviteOpen(true)}>
          Invite a user
        </Button>
      </Box>

      <Box sx={{ display: 'flex', gap: 3, mb: 6, flexWrap: 'wrap' }}>
        <TextField
          label="Search"
          value={filters.q ?? ''}
          onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value === '' ? undefined : event.target.value }))}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          label="Kind"
          value={filters.kind ?? ''}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, kind: (event.target.value === '' ? undefined : event.target.value) as ListUsersKind | undefined }))
          }
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="staff">Staff</MenuItem>
          <MenuItem value="customer">Customer</MenuItem>
        </TextField>
        <TextField
          select
          label="Status"
          value={filters.status ?? ''}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, status: (event.target.value === '' ? undefined : event.target.value) as UserStatus | undefined }))
          }
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="invited">Invited</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="deactivated">Deactivated</MenuItem>
        </TextField>
        <TextField
          select
          label="Role"
          value={filters.roleId ?? ''}
          onChange={(event) => setFilters((prev) => ({ ...prev, roleId: event.target.value === '' ? undefined : event.target.value }))}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">All</MenuItem>
          {roles.map((role) => (
            <MenuItem key={role.id} value={role.id}>
              {role.name}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {usersQuery.isPending && <Skeleton variant="list" rows={8} label="users" />}

      {usersQuery.isError && (
        <EmptyState
          variant="error"
          title="Couldn't load users"
          message={usersQuery.error?.message}
          onRetry={() => void usersQuery.refetch()}
        />
      )}

      {!usersQuery.isPending && !usersQuery.isError && users.length === 0 && <EmptyState title="No users match these filters" />}

      {!usersQuery.isPending && !usersQuery.isError && users.length > 0 && (
        <>
          {/* The table is wider than a phone: it scrolls inside its container rather than
              widening the page (ui-components: no horizontal page scroll at phone width). */}
          <TableContainer sx={{ maxWidth: '100%' }}>
            <Table aria-label="Users" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Roles</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Last sign-in</TableCell>
                  <TableCell align="right">
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>{user.name}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      {user.roles
                        .map((role) => role.name)
                        .filter((name): name is string => Boolean(name))
                        .join(', ') || '—'}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        {statusLabel(user.status)}
                        {user.locked === true && <Chip label="Locked" color="warning" size="small" />}
                      </Box>
                    </TableCell>
                    <TableCell>{formatLastSignIn(user.lastSignInAt)}</TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {user.status === 'deactivated' ? (
                          <Button size="small" onClick={() => setPendingAction({ type: 'reactivate', user })}>
                            Reactivate
                          </Button>
                        ) : (
                          <Button size="small" onClick={() => setPendingAction({ type: 'deactivate', user })}>
                            Deactivate
                          </Button>
                        )}
                        <Button size="small" color="error" onClick={() => setPendingAction({ type: 'delete', user })}>
                          Delete
                        </Button>
                        <Button size="small" color="error" onClick={() => setPendingAction({ type: 'erase', user })}>
                          Erase
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {usersQuery.hasNextPage === true && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
              <Button onClick={() => void usersQuery.fetchNextPage()} disabled={usersQuery.isFetchingNextPage}>
                {usersQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          )}
        </>
      )}

      <InviteUserDialog open={inviteOpen} onClose={() => setInviteOpen(false)} roles={roles} />

      {pendingAction !== null && (
        <ConfirmationDialog
          open
          title={actionTitle(pendingAction.type)}
          message={actionMessage(pendingAction)}
          confirmLabel={actionConfirmLabel(pendingAction.type)}
          destructive={pendingAction.type !== 'reactivate'}
          requireText={pendingAction.type === 'erase' ? 'ERASE' : undefined}
          onClose={() => setPendingAction(null)}
          onConfirm={() => runAction(pendingAction)}
        />
      )}
    </Box>
  );
}

interface InviteUserDialogProps {
  open: boolean;
  onClose: () => void;
  roles: Role[];
}

function InviteUserDialog({ open, onClose, roles }: InviteUserDialogProps) {
  const inviteUser = useInviteUser();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);

  const close = () => {
    setEmail('');
    setName('');
    setRoleIds([]);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Invite a user">
      <Form
        label="Invite a user"
        onSubmit={async () => {
          await inviteUser.mutateAsync({ email, name: name.trim() === '' ? undefined : name.trim(), roleIds });
          toast({ message: `Invited ${email}`, severity: 'success' });
          close();
        }}
      >
        <FormField
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <FormField name="name" label="Name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        <FormControl fullWidth>
          <InputLabel id="invite-user-roles-label">Roles</InputLabel>
          <Select<string[]>
            labelId="invite-user-roles-label"
            label="Roles"
            multiple
            value={roleIds}
            onChange={(event: SelectChangeEvent<string[]>) => {
              const { value } = event.target;
              setRoleIds(typeof value === 'string' ? value.split(',') : value);
            }}
            renderValue={(selected) =>
              roles
                .filter((role) => selected.includes(role.id))
                .map((role) => role.name)
                .join(', ')
            }
          >
            {roles.map((role) => (
              <MenuItem key={role.id} value={role.id}>
                <Checkbox checked={roleIds.includes(role.id)} />
                <ListItemText primary={role.name} />
              </MenuItem>
            ))}
          </Select>
          <FormHelperText>Choose at least one role</FormHelperText>
        </FormControl>
        <FormError />
        <SubmitButton disabled={roleIds.length === 0}>Send invitation</SubmitButton>
      </Form>
    </Modal>
  );
}
