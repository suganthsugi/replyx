import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useSignIn } from '../../../data/auth';
import { mapError } from '../../../data/errors';
import { authErrorMessage } from '../../shared/authErrorMessage';

/** Staff sign-in with email and password (FR-011). */
export default function SignInPage() {
  const signIn = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | undefined>();

  const submit = async () => {
    setNotice(undefined);
    try {
      await signIn.mutateAsync({ email, password });
      void navigate('/desk', { replace: true });
    } catch (caught) {
      const uiError = mapError(caught);
      if (uiError.fieldErrors !== undefined) throw caught;
      setNotice(authErrorMessage(uiError));
    }
  };

  return (
    <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 6 }}>
        Sign in
      </Typography>
      <Form label="Sign in" onSubmit={submit}>
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
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {notice !== undefined && <Alert severity="error">{notice}</Alert>}
        <FormError />
        <SubmitButton fullWidth>Sign in</SubmitButton>
      </Form>
      <Box sx={{ mt: 4, textAlign: 'center' }}>
        <Link component={RouterLink} to="/desk/forgot-password">
          Forgot your password?
        </Link>
      </Box>
    </Box>
  );
}
