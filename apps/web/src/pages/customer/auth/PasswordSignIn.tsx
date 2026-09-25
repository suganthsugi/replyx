import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useCustomerPasswordSignIn } from '../../../data/customer-auth';
import { mapError } from '../../../data/errors';
import { authErrorMessage } from '../../shared/authErrorMessage';

export interface PasswordSignInProps {
  initialEmail?: string;
  onBack: () => void;
}

/** The alternative to a sign-in link, for customers who have set a password (FR-012). */
export function PasswordSignIn({ initialEmail = '', onBack }: PasswordSignInProps) {
  const signIn = useCustomerPasswordSignIn();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | undefined>();

  const submit = async () => {
    setNotice(undefined);
    try {
      await signIn.mutateAsync({ email, password });
    } catch (caught) {
      const uiError = mapError(caught);
      if (uiError.fieldErrors !== undefined) throw caught;
      setNotice(authErrorMessage(uiError));
    }
  };

  return (
    <Box>
      <Typography component="h1" variant="h4" sx={{ mb: 6 }}>
        Sign in with your password
      </Typography>
      <Form label="Sign in with your password" onSubmit={submit}>
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
        <Link component="button" type="button" onClick={onBack}>
          Use a sign-in link instead
        </Link>
      </Box>
    </Box>
  );
}
