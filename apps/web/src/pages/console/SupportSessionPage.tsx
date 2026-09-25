import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { EmptyState } from '../../components/foundations/EmptyState';
import { useOpenSupportSession } from '../../data/console';
import { mapError } from '../../data/errors';

import type { SupportSession } from '../../api/generated/model';

/**
 * Opening a read-only support session for one tenant (FR-001a). There is nothing to configure:
 * either the tenant's admins have granted access, or the operator has to ask them for it.
 *
 * The token is shown once and belongs in the operator's own hands — it is the credential on the
 * tenant host, it expires with the grant, and it stops the moment an admin revokes.
 */
export default function SupportSessionPage() {
  const { id = '' } = useParams<{ id: string }>();
  const openSession = useOpenSupportSession();
  const navigate = useNavigate();
  const [session, setSession] = useState<SupportSession | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const open = async () => {
    setNotice(undefined);
    try {
      setSession(await openSession.mutateAsync({ id }));
    } catch (caught) {
      const uiError = mapError(caught);
      setNotice(
        uiError.code === 'SUPPORT_ACCESS_NOT_GRANTED'
          ? 'This workspace has not granted support access. An admin there has to grant it first.'
          : uiError.message,
      );
    }
  };

  if (id === '') {
    return (
      <Box component="main" sx={{ maxWidth: 640, mx: 'auto', px: 4, py: 8 }}>
        <EmptyState
          variant="error"
          title="No tenant in this address"
          message="Open a support session from the tenant list."
          headingLevel={1}
          action={{ label: 'Back to tenants', onClick: () => void navigate('/') }}
        />
      </Box>
    );
  }

  return (
    <Box component="main" sx={{ maxWidth: 640, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Support session
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
        Opening a session gives you read-only access to this workspace while its admins allow it.
        Every page you open is written to their audit log, and nothing you do can change their data.
      </Typography>

      {session === undefined ? (
        <>
          {notice !== undefined && (
            <Alert severity="warning" sx={{ mb: 4 }}>
              {notice}
            </Alert>
          )}
          <Button variant="contained" onClick={() => void open()} disabled={openSession.isPending}>
            {openSession.isPending ? 'Opening…' : 'Open a support session'}
          </Button>
        </>
      ) : (
        <Box>
          <Alert severity="success" sx={{ mb: 4 }}>
            Session open until {new Date(session.expiresAt).toLocaleString()}.
          </Alert>
          <Typography component="h2" variant="h6" sx={{ mb: 2 }}>
            Workspace
          </Typography>
          <Typography sx={{ mb: 4 }}>
            <Link href={`https://${session.tenantHost}/desk`} rel="noreferrer">
              {session.tenantHost}
            </Link>
          </Typography>
          <Typography component="h2" variant="h6" sx={{ mb: 2 }}>
            Access token
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Shown once. Send it as the <code>X-Support-Token</code> header; it is read-only and ends
            with the grant.
          </Typography>
          <Box
            component="code"
            sx={{
              display: 'block',
              p: 3,
              borderRadius: 1,
              bgcolor: 'action.hover',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
            }}
          >
            {session.token}
          </Box>
          <Button sx={{ mt: 4 }} onClick={() => void navigate('/')}>
            Back to tenants
          </Button>
        </Box>
      )}
    </Box>
  );
}
