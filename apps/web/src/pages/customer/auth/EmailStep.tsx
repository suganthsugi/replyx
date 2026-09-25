import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useRequestSignInLink } from '../../../data/customer-auth';

export interface EmailStepProps {
  /** Called once the link has been requested, with the email it was sent to. */
  onSent: (email: string) => void;
  onUsePassword: () => void;
}

/**
 * The first (and often only) step of customer sign-in (FR-012): email, and a name in case this
 * is a new self-registered account — the server decides whether the name is used at all, so this
 * form asks for both without knowing that setting.
 */
export function EmailStep({ onSent, onUsePassword }: EmailStepProps) {
  const requestLink = useRequestSignInLink();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  return (
    <Box>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Sign in
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
        Enter your email and we&apos;ll send you a one-time link to sign in.
      </Typography>
      <Form
        label="Sign in with email"
        onSubmit={async () => {
          await requestLink.mutateAsync({ email, name: name.trim() === '' ? undefined : name.trim() });
          onSent(email);
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
        <FormField
          name="name"
          label="Name"
          helperText="Only needed if you're new here"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <FormError />
        <SubmitButton fullWidth>Send sign-in link</SubmitButton>
      </Form>
      <Box sx={{ mt: 4, textAlign: 'center' }}>
        <Link component="button" type="button" onClick={onUsePassword}>
          Sign in with a password instead
        </Link>
      </Box>
    </Box>
  );
}
