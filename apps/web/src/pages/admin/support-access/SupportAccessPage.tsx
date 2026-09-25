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
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { useGrantSupportAccess, useRevokeSupportAccess, useSupportAccessGrants } from '../../../data/support-access';

import type { SupportAccessGrant } from '../../../api/generated/model';

/**
 * Who at the platform may look at this workspace, and until when (FR-001a). Access is always
 * read-only and always time-limited: the admin picks the window and can end it early.
 */

const DURATION_OPTIONS = [
  { value: 1, label: '1 hour' },
  { value: 4, label: '4 hours' },
  { value: 24, label: '1 day' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days (maximum)' },
];

function formatDate(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : new Date(value).toLocaleString();
}

function statusOf(grant: SupportAccessGrant): { label: string; active: boolean } {
  if (grant.active === true) return { label: 'Active', active: true };
  if (grant.revokedAt !== null && grant.revokedAt !== undefined) return { label: 'Revoked', active: false };
  return { label: 'Expired', active: false };
}

export default function SupportAccessPage() {
  const grantsQuery = useSupportAccessGrants();
  const grantAccess = useGrantSupportAccess();
  const revokeAccess = useRevokeSupportAccess();
  const toast = useToast();
  const [durationHours, setDurationHours] = useState(24);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<SupportAccessGrant | null>(null);

  const grants = grantsQuery.data ?? [];

  return (
    <Box component="main" sx={{ px: { xs: 4, sm: 6 }, py: 6 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Support access
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 8, maxWidth: 640 }}>
        Let the platform&apos;s support team read this workspace for a limited time. Access is
        read-only — they can never change or delete anything — and every page they open is recorded
        in your audit log. You can end access at any moment.
      </Typography>

      <Typography component="h2" variant="h6" sx={{ mb: 3 }}>
        Grant access
      </Typography>
      <Box sx={{ maxWidth: 480, mb: 8 }}>
        <Form
          label="Grant support access"
          onSubmit={async () => {
            await grantAccess.mutateAsync({ durationHours, reason: reason.trim() === '' ? undefined : reason.trim() });
            setReason('');
            toast({ message: 'Support access granted', severity: 'success' });
          }}
        >
          <FormField
            name="durationHours"
            label="For how long"
            select
            value={String(durationHours)}
            onChange={(event) => setDurationHours(Number(event.target.value))}
          >
            {DURATION_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={String(option.value)}>
                {option.label}
              </MenuItem>
            ))}
          </FormField>
          <FormField
            name="reason"
            label="Reason"
            helperText="Optional; shown in your audit log"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <FormError />
          <SubmitButton>Grant access</SubmitButton>
        </Form>
      </Box>

      <Typography component="h2" variant="h6" sx={{ mb: 3 }}>
        Grants
      </Typography>

      {grantsQuery.isPending && <Skeleton variant="list" rows={4} label="support access grants" />}

      {grantsQuery.isError && (
        <EmptyState
          variant="error"
          title="Couldn't load support access"
          message={grantsQuery.error?.message}
          onRetry={() => void grantsQuery.refetch()}
        />
      )}

      {!grantsQuery.isPending && !grantsQuery.isError && grants.length === 0 && (
        <EmptyState title="Nobody has support access" message="Grant it above when the support team asks for it." />
      )}

      {!grantsQuery.isPending && !grantsQuery.isError && grants.length > 0 && (
        <TableContainer sx={{ maxWidth: '100%' }}>
          <Table aria-label="Support access grants" sx={{ minWidth: 640 }}>
            <TableHead>
              <TableRow>
                <TableCell>Status</TableCell>
                <TableCell>Granted by</TableCell>
                <TableCell>From</TableCell>
                <TableCell>Until</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell align="right">
                  <VisuallyHidden>Actions</VisuallyHidden>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {grants.map((row) => {
                const status = statusOf(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Chip size="small" label={status.label} color={status.active ? 'success' : 'default'} />
                    </TableCell>
                    <TableCell>{row.grantedBy?.name ?? '—'}</TableCell>
                    <TableCell>{formatDate(row.startsAt)}</TableCell>
                    <TableCell>{formatDate(row.expiresAt)}</TableCell>
                    <TableCell>{row.reason ?? '—'}</TableCell>
                    <TableCell align="right">
                      {status.active && (
                        <Button size="small" color="error" onClick={() => setPending(row)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {pending !== null && (
        <ConfirmationDialog
          open
          title="Revoke support access"
          message="The support team loses access to this workspace immediately."
          confirmLabel="Revoke"
          destructive
          onClose={() => setPending(null)}
          onConfirm={async () => {
            await revokeAccess.mutateAsync({ id: pending.id });
            toast({ message: 'Support access revoked', severity: 'success' });
          }}
        />
      )}
    </Box>
  );
}
