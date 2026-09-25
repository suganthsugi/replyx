import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useConfirmPasswordReset } from '../../../data/auth';
import { mapError } from '../../../data/errors';
import { authErrorMessage, isInvalidToken } from '../../shared/authErrorMessage';

/** Sets a new password from the link in a reset email (FR-011). */
export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const confirmReset = useConfirmPasswordReset();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  if (token === '') {
    return (
      <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
        <EmptyState
          variant="error"
          title="This reset link is incomplete"
          message="Check the address in your email, or request a new one."
          headingLevel={1}
          action={{ label: 'Request a new link', onClick: () => void navigate('/desk/forgot-password') }}
        />
      </Box>
    );
  }

  if (done) {
    return (
      <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
        <Typography component="h1" variant="h4" sx={{ mb: 4 }}>
          Password updated
        </Typography>
        <Typography sx={{ mb: 6 }}>Your password has been changed. Sign in with your new password.</Typography>
        <Button variant="contained" component={RouterLink} to="/desk/sign-in">
          Go to sign in
        </Button>
      </Box>
    );
  }

  const submit = async () => {
    setNotice(undefined);
    try {
      await confirmReset.mutateAsync({ token, password });
      setDone(true);
    } catch (caught) {
      const uiError = mapError(caught);
      if (isInvalidToken(uiError)) {
        setNotice(authErrorMessage({ ...uiError, code: 'LINK_INVALID_OR_EXPIRED' }));
        return;
      }
      if (uiError.fieldErrors !== undefined) throw caught;
      setNotice(authErrorMessage(uiError));
    }
  };

  return (
    <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 6 }}>
        Choose a new password
      </Typography>
      <Form label="Reset your password" onSubmit={submit}>
        <FormField
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          helperText="At least 12 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {notice !== undefined && <Alert severity="error">{notice}</Alert>}
        <FormError />
        <SubmitButton fullWidth>Set new password</SubmitButton>
      </Form>
    </Box>
  );
}
