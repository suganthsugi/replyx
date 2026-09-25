import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Form, FormError, FormField, SubmitButton } from '../../components/shell/Form';
import { useOperatorSignIn } from '../../data/console';
import { mapError } from '../../data/errors';
import { authErrorMessage } from '../shared/authErrorMessage';

/** Platform operator sign-in, on the console host only (FR-001). */
export default function ConsoleSignInPage() {
  const signIn = useOperatorSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | undefined>();

  const submit = async () => {
    setNotice(undefined);
    try {
      await signIn.mutateAsync({ email, password });
      void navigate('/', { replace: true });
    } catch (caught) {
      const uiError = mapError(caught);
      if (uiError.fieldErrors !== undefined) throw caught;
      setNotice(authErrorMessage(uiError));
    }
  };

  return (
    <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Platform console
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
        Sign in with your operator account.
      </Typography>
      <Form label="Operator sign-in" onSubmit={submit}>
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
    </Box>
  );
}
