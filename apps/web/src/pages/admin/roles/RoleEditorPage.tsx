import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';

import { PermissionList } from '../../../components/builders/PermissionList';
import { PermissionMatrix, type MatrixEntry } from '../../../components/builders/PermissionMatrix';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { issueMessage } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { mapError, type UiError } from '../../../data/errors';
import { useGroups, type Group } from '../../../data/groups';
import {
  groupsLosingEdit,
  useCreateRole,
  useNewPermissionKeys,
  usePermissions,
  useRole,
  useUpdateRole,
  type Permission,
  type Role,
} from '../../../data/roles';

import { ROLES_PATH } from './RolesPage';

/**
 * Create or edit a role (FR-017–FR-026): name and description, the permission list on top and
 * the groups × actions matrix below. Admin is shown read-only (its access is fixed, FR-019);
 * other system roles keep their name. Saving an edit that takes Edit away from a group asks
 * first, because owners who relied on it are unassigned from that group's tickets (FR-026).
 */

export default function RoleEditorPage() {
  const { id } = useParams();
  const isNew = id === undefined || id === 'new';
  const roleQuery = useRole(isNew ? undefined : id);
  const permissionsQuery = usePermissions();
  const groupsQuery = useGroups();
  const newKeys = useNewPermissionKeys(permissionsQuery.data);
  const held = new Set(useMe().data?.permissions ?? []);

  const loading = permissionsQuery.isPending || groupsQuery.isPending || (!isNew && roleQuery.isPending);
  const error = permissionsQuery.error ?? groupsQuery.error ?? (isNew ? undefined : roleQuery.error);

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Link component={RouterLink} to={ROLES_PATH} variant="body2">
          ← All roles
        </Link>
        {loading && <Skeleton variant="block" label="role" />}
        {!loading && error !== undefined && (
          <EmptyState
            variant="error"
            title={error.code === 'ROLE_NOT_FOUND' ? 'Role not found' : "Couldn't load the role"}
            message={error.code === 'ROLE_NOT_FOUND' ? 'It may have been deleted.' : error.message}
            headingLevel={1}
            onRetry={
              error.code === 'ROLE_NOT_FOUND'
                ? undefined
                : () => {
                    void permissionsQuery.refetch();
                    void groupsQuery.refetch();
                    if (!isNew) void roleQuery.refetch();
                  }
            }
          />
        )}
        {!loading && error === undefined && (
          <RoleForm
            key={roleQuery.data?.id ?? 'new'}
            role={isNew ? undefined : roleQuery.data}
            permissions={permissionsQuery.data ?? []}
            groups={groupsQuery.data ?? []}
            newKeys={newKeys}
            canSave={held.has(isNew ? 'role.create' : 'role.edit')}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}

function RoleForm({
  role,
  permissions,
  groups,
  newKeys,
  canSave,
}: {
  role: Role | undefined;
  permissions: readonly Permission[];
  groups: readonly Group[];
  newKeys: ReadonlySet<string>;
  canSave: boolean;
}) {
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [granted, setGranted] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const [access, setAccess] = useState<MatrixEntry[]>(() => [...(role?.groupAccess ?? [])]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiError | undefined>();
  const [confirmLost, setConfirmLost] = useState<(string | null)[] | null>(null);

  const locked = role?.system === 'admin';
  const readOnly = locked || !canSave;
  const nameFixed = role !== undefined && role.system !== null;
  const title = role === undefined ? 'New role' : role.name;

  const input = () => ({
    name: name.trim(),
    ...(description.trim() === '' ? {} : { description: description.trim() }),
    permissions: [...granted].sort(),
    groupAccess: access,
  });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      if (role === undefined) {
        const created = await createRole.mutateAsync(input());
        toast({ message: `${created.name} created`, severity: 'success' });
        void navigate(`${ROLES_PATH}/${created.id}`, { replace: true });
      } else {
        await updateRole.mutateAsync({ id: role.id, ...input() });
        toast({ message: 'Role saved', severity: 'success' });
      }
    } catch (caught) {
      setError(mapError(caught));
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    const lost = role === undefined ? [] : groupsLosingEdit(role.groupAccess, access);
    if (lost.length > 0) setConfirmLost(lost);
    else void save();
  };

  const groupName = (groupId: string | null) => (groupId === null ? 'Ungrouped' : (groups.find((g) => g.id === groupId)?.name ?? 'a deleted group'));
  const nameIssue = error?.fieldErrors?.name;
  const otherError = error !== undefined && (error.fieldErrors === undefined || nameIssue === undefined) ? error : undefined;

  return (
    <Box
      component="form"
      noValidate
      aria-label={role === undefined ? 'New role' : `Edit ${role.name}`}
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving && !readOnly) onSave();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 6, mt: 4 }}
    >
      <Box>
        <Typography component="h1" variant="h1">
          {title}
        </Typography>
        {locked && (
          <Alert severity="info" sx={{ mt: 3 }}>
            Admin always has every permission and full access to every group. It can&apos;t be changed.
          </Alert>
        )}
        {!locked && !canSave && (
          <Alert severity="info" sx={{ mt: 3 }}>
            You can view this role but not change it.
          </Alert>
        )}
      </Box>

      <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, maxWidth: 800 }}>
        <TextField
          label="Name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={readOnly || nameFixed || saving}
          required
          error={nameIssue !== undefined}
          helperText={nameIssue !== undefined ? issueMessage(nameIssue) : nameFixed ? 'System roles keep their name' : undefined}
          slotProps={{ htmlInput: { maxLength: 60 } }}
        />
        <TextField
          label="Description"
          name="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={readOnly || saving}
          slotProps={{ htmlInput: { maxLength: 300 } }}
        />
      </Box>

      <Box component="section" aria-labelledby="role-permissions">
        <Typography id="role-permissions" component="h2" variant="h2" sx={{ mb: 1 }}>
          Permissions
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          What the role can do. Ticket permissions work only in the groups granted below.
        </Typography>
        <PermissionList
          permissions={permissions}
          value={locked ? new Set(permissions.map((p) => p.key)) : granted}
          onChange={setGranted}
          locked={readOnly}
          newKeys={newKeys}
        />
      </Box>

      <Box component="section" aria-labelledby="role-groups">
        <Typography id="role-groups" component="h2" variant="h2" sx={{ mb: 1 }}>
          Group access
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          Which groups&apos; tickets the role reaches. Without View, a group&apos;s tickets stay hidden.
        </Typography>
        <PermissionMatrix label={`Group access for ${title}`} groups={groups} value={access} onChange={setAccess} locked={readOnly} />
      </Box>

      {otherError !== undefined && <Alert severity="error">{otherError.message}</Alert>}

      {!readOnly && (
        <Box sx={{ display: 'flex', gap: 3 }}>
          <Button
            type="submit"
            variant="contained"
            disabled={saving}
            aria-busy={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined}
          >
            {role === undefined ? 'Create role' : 'Save changes'}
          </Button>
          <Button onClick={() => void navigate(ROLES_PATH)} disabled={saving}>
            Cancel
          </Button>
        </Box>
      )}

      {confirmLost !== null && (
        <ConfirmationDialog
          open
          title="Remove Edit access?"
          message={
            <Typography>
              Users with this role lose Edit on {confirmLost.map(groupName).join(', ')}. Where that was their only way to
              edit, they are unassigned from the tickets they own there.
            </Typography>
          }
          confirmLabel="Save and unassign"
          destructive
          onClose={() => setConfirmLost(null)}
          onConfirm={() => save()}
        />
      )}
    </Box>
  );
}
