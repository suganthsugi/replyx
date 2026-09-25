import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { useDeleteRole, useRoles, type Role } from '../../../data/roles';
import { WORKSPACE_BASE } from '../../../routes/area';

/**
 * The tenant's roles (FR-016–FR-020): the four system roles and any custom ones, with how many
 * users hold each. System roles open read-only for their name; only unused custom roles can be
 * deleted (the API answers `ROLE_IN_USE` otherwise, shown in the dialog).
 */

export const ROLES_PATH = `${WORKSPACE_BASE}/admin/roles`;

const SYSTEM_LABELS: Record<string, string> = { admin: 'Admin', manager: 'Manager', agent: 'Agent', customer: 'Customer' };

export default function RolesPage() {
  const rolesQuery = useRoles();
  const deleteRole = useDeleteRole();
  const permissions = new Set(useMe().data?.permissions ?? []);
  const toast = useToast();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Role | null>(null);

  const roles = rolesQuery.data ?? [];

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1">
            Roles
          </Typography>
          {permissions.has('role.create') && (
            <Button variant="contained" onClick={() => void navigate(`${ROLES_PATH}/new`)}>
              New role
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 640 }}>
          A role combines permissions with access to groups of tickets. A user&apos;s access is everything
          their roles allow, together. Changes apply to signed-in users right away.
        </Typography>

        {rolesQuery.isPending && <Skeleton variant="list" rows={5} label="roles" />}

        {rolesQuery.isError && (
          <EmptyState variant="error" title="Couldn't load roles" message={rolesQuery.error?.message} onRetry={() => void rolesQuery.refetch()} />
        )}

        {!rolesQuery.isPending && !rolesQuery.isError && roles.length === 0 && <EmptyState title="No roles yet" />}

        {!rolesQuery.isPending && !rolesQuery.isError && roles.length > 0 && (
          <TableContainer sx={{ position: 'relative', border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}>
            <Table aria-label="Roles" sx={{ minWidth: 560 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell align="right">Users</TableCell>
                  <TableCell align="right">Permissions</TableCell>
                  <TableCell align="right">
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {roles.map((role) => (
                  <TableRow key={role.id} hover>
                    <TableCell>
                      <Link component={RouterLink} to={`${ROLES_PATH}/${role.id}`} sx={{ fontWeight: 600 }}>
                        {role.name}
                      </Link>
                      {role.description !== undefined && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {role.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={role.system === null ? 'Custom' : `System · ${SYSTEM_LABELS[role.system] ?? role.system}`} />
                    </TableCell>
                    <TableCell align="right">{role.userCount}</TableCell>
                    <TableCell align="right">{role.permissions.length}</TableCell>
                    <TableCell align="right">
                      {role.system === null && permissions.has('role.delete') && (
                        <Button size="small" color="error" onClick={() => setPending(role)} aria-label={`Delete ${role.name}`}>
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

        {pending !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${pending.name}`}
            message={
              pending.userCount > 0
                ? `${pending.userCount === 1 ? 'One user holds' : `${pending.userCount} users hold`} this role. Give them another role first.`
                : 'The role is removed for good. Nobody holds it, so nobody loses access.'
            }
            confirmLabel="Delete role"
            destructive
            onClose={() => setPending(null)}
            onConfirm={async () => {
              await deleteRole.mutateAsync({ id: pending.id });
              toast({ message: `${pending.name} deleted`, severity: 'success' });
            }}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}
