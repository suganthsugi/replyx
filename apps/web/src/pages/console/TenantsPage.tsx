import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { EmptyState } from '../../components/foundations/EmptyState';
import { Skeleton } from '../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../components/foundations/VisuallyHidden';
import { ConfirmationDialog } from '../../components/shell/ConfirmationDialog';
import { Form, FormError, FormField, SubmitButton } from '../../components/shell/Form';
import { Modal } from '../../components/shell/Modal';
import { useToast } from '../../components/shell/Toast';
import { useCreateTenant, useReactivateTenant, useSuspendTenant, useTenants, type TenantFilters } from '../../data/console';

import ConsoleSignInPage from './ConsoleSignInPage';

import type { ListTenantsStatus, Tenant } from '../../api/generated/model';

/**
 * Every tenant on the platform (FR-001, FR-004): status, size, whether support access is open,
 * and the actions an operator has — create, suspend, reactivate, and open a support session.
 */

function formatDate(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : new Date(value).toLocaleString();
}

export default function TenantsPage() {
  const [filters, setFilters] = useState<TenantFilters>({});
  const tenantsQuery = useTenants(filters);
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<{ tenant: Tenant; action: 'suspend' | 'reactivate' } | null>(null);
  const suspendTenant = useSuspendTenant();
  const reactivateTenant = useReactivateTenant();
  const navigate = useNavigate();
  const toast = useToast();

  const tenants = tenantsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  // The console's only door: an operator without a session gets the form, not an error.
  if (tenantsQuery.isError && tenantsQuery.error?.code === 'UNAUTHENTICATED') return <ConsoleSignInPage />;

  const runAction = async () => {
    if (pending === null) return;
    if (pending.action === 'suspend') {
      await suspendTenant.mutateAsync({ id: pending.tenant.id });
      toast({ message: `${pending.tenant.name} suspended`, severity: 'success' });
      return;
    }
    await reactivateTenant.mutateAsync({ id: pending.tenant.id });
    toast({ message: `${pending.tenant.name} reactivated`, severity: 'success' });
  };

  return (
    <Box component="main" sx={{ px: { xs: 4, sm: 6 }, py: 6 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 6, flexWrap: 'wrap', gap: 3 }}>
        <Typography component="h1" variant="h4">
          Tenants
        </Typography>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          Create a tenant
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
          label="Status"
          value={filters.status ?? ''}
          onChange={(event) =>
            setFilters((prev) => ({
              ...prev,
              status: (event.target.value === '' ? undefined : event.target.value) as ListTenantsStatus | undefined,
            }))
          }
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="suspended">Suspended</MenuItem>
        </TextField>
      </Box>

      {tenantsQuery.isPending && <Skeleton variant="list" rows={6} label="tenants" />}

      {tenantsQuery.isError && (
        <EmptyState
          variant="error"
          title="Couldn't load tenants"
          message={tenantsQuery.error?.message}
          onRetry={() => void tenantsQuery.refetch()}
        />
      )}

      {!tenantsQuery.isPending && !tenantsQuery.isError && tenants.length === 0 && (
        <EmptyState title="No tenants match these filters" />
      )}

      {!tenantsQuery.isPending && !tenantsQuery.isError && tenants.length > 0 && (
        <>
          {/* Wider than a phone: the table scrolls inside its container, not the page. */}
          <TableContainer sx={{ maxWidth: '100%' }}>
            <Table aria-label="Tenants" sx={{ minWidth: 760 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Address</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Staff</TableCell>
                  <TableCell>Customers</TableCell>
                  <TableCell>Support access</TableCell>
                  <TableCell align="right">
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id}>
                    <TableCell>{tenant.name}</TableCell>
                    <TableCell>{tenant.slug}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={tenant.status === 'suspended' ? 'Suspended' : 'Active'}
                        color={tenant.status === 'suspended' ? 'warning' : 'default'}
                      />
                    </TableCell>
                    <TableCell>{tenant.stats?.staffUsers ?? 0}</TableCell>
                    <TableCell>{tenant.stats?.customers ?? 0}</TableCell>
                    <TableCell>
                      {tenant.activeSupportGrantUntil === null || tenant.activeSupportGrantUntil === undefined
                        ? 'Not granted'
                        : `Until ${formatDate(tenant.activeSupportGrantUntil)}`}
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <Button size="small" onClick={() => void navigate(`/tenants/${tenant.id}/support`)}>
                          Support session
                        </Button>
                        {tenant.status === 'suspended' ? (
                          <Button size="small" onClick={() => setPending({ tenant, action: 'reactivate' })}>
                            Reactivate
                          </Button>
                        ) : (
                          <Button size="small" color="error" onClick={() => setPending({ tenant, action: 'suspend' })}>
                            Suspend
                          </Button>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {tenantsQuery.hasNextPage === true && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
              <Button onClick={() => void tenantsQuery.fetchNextPage()} disabled={tenantsQuery.isFetchingNextPage}>
                {tenantsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          )}
        </>
      )}

      <CreateTenantDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      {pending !== null && (
        <ConfirmationDialog
          open
          title={pending.action === 'suspend' ? 'Suspend tenant' : 'Reactivate tenant'}
          message={
            pending.action === 'suspend'
              ? `${pending.tenant.name} will be signed out and unreachable for its customers. Nothing is deleted, and you can reactivate it at any time.`
              : `${pending.tenant.name} will be reachable again, with its data unchanged.`
          }
          confirmLabel={pending.action === 'suspend' ? 'Suspend' : 'Reactivate'}
          destructive={pending.action === 'suspend'}
          onClose={() => setPending(null)}
          onConfirm={runAction}
        />
      )}
    </Box>
  );
}

function CreateTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createTenant = useCreateTenant();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminEmail, setAdminEmail] = useState('');

  const close = () => {
    setName('');
    setSlug('');
    setAdminEmail('');
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Create a tenant">
      <Form
        label="Create a tenant"
        onSubmit={async () => {
          await createTenant.mutateAsync({ name, slug, adminEmail });
          toast({ message: `${name} created; ${adminEmail} was invited`, severity: 'success' });
          close();
        }}
      >
        <FormField name="name" label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} required />
        <FormField
          name="slug"
          label="Address"
          helperText="Lowercase letters, digits and single hyphens; 3 to 40 characters"
          value={slug}
          onChange={(event) => setSlug(event.target.value.toLowerCase())}
          required
        />
        <FormField
          name="adminEmail"
          label="First admin's email"
          type="email"
          helperText="They receive an invitation to set their password"
          value={adminEmail}
          onChange={(event) => setAdminEmail(event.target.value)}
          required
        />
        <FormError />
        <SubmitButton>Create and invite</SubmitButton>
      </Form>
    </Modal>
  );
}
