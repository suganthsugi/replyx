import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useRequestPasswordReset } from '../../../data/auth';

/** Requests a password reset email; the response is the same whether or not the account exists. */
export default function ForgotPasswordPage() {
  const requestReset = useRequestPasswordReset();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  return (
    <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 6 }}>
        Reset your password
      </Typography>
      {sent ? (
        <Typography role="status">
          If an account exists for <strong>{email}</strong>, we&apos;ve sent a link to reset the password.
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
            Enter your email and we&apos;ll send you a link to reset your password.
          </Typography>
          <Form
            label="Request a password reset"
            onSubmit={async () => {
              await requestReset.mutateAsync({ email });
              setSent(true);
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
            <FormError />
            <SubmitButton fullWidth>Send reset link</SubmitButton>
          </Form>
        </>
      )}
      <Box sx={{ mt: 4, textAlign: 'center' }}>
        <Link component={RouterLink} to="/desk/sign-in">
          Back to sign in
        </Link>
      </Box>
    </Box>
  );
}
