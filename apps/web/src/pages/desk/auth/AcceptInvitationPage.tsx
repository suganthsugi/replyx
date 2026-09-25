import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useAcceptInvitation, useInvitation } from '../../../data/auth';

/** A staff member setting their name and password from an invitation email (FR-010). */
export default function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const invitationQuery = useInvitation(token);
  const acceptInvitation = useAcceptInvitation(token);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  if (token === '') {
    return (
      <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8 }}>
        <VisuallyHidden component="h1">Accept invitation</VisuallyHidden>
        <EmptyState variant="error" title="This invitation link is incomplete" message="Check the address in your invitation email." />
      </Box>
    );
  }

  if (invitationQuery.isPending) {
    return (
      <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8 }}>
        <Skeleton variant="block" label="your invitation" />
      </Box>
    );
  }

  if (invitationQuery.isError) {
    return (
      <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8 }}>
        <VisuallyHidden component="h1">Accept invitation</VisuallyHidden>
        <EmptyState
          variant="error"
          title="This invitation is no longer valid"
          message={invitationQuery.error?.message}
          action={{ label: 'Back to sign in', onClick: () => void navigate('/desk/sign-in') }}
        />
      </Box>
    );
  }

  const invitation = invitationQuery.data;

  return (
    <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Join {invitation.tenantName}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
        Set your name and password to accept the invitation sent to <strong>{invitation.email}</strong>.
      </Typography>
      <Form
        label="Accept the invitation"
        onSubmit={async () => {
          await acceptInvitation.mutateAsync({ name, password });
          void navigate('/desk', { replace: true });
        }}
      >
        <FormField
          name="name"
          label="Name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <FormField
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          helperText="At least 12 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <FormError />
        <SubmitButton fullWidth>Accept and continue</SubmitButton>
      </Form>
    </Box>
  );
}
