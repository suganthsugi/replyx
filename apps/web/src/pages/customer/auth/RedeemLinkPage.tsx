import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { Form, FormError, SubmitButton } from '../../../components/shell/Form';
import { useRedeemSignInLink } from '../../../data/customer-auth';
import { mapError } from '../../../data/errors';
import { authErrorMessage, isInvalidToken } from '../../shared/authErrorMessage';

/** Where the customer sign-in email links to (`/sign-in/redeem?token=`); finishes the one-time sign-in (FR-012). */
export default function RedeemLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const redeem = useRedeemSignInLink();
  const navigate = useNavigate();
  const [trustDevice, setTrustDevice] = useState(true);
  const [notice, setNotice] = useState<string | undefined>();

  if (token === '') {
    return (
      <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
        <VisuallyHidden component="h1">Sign in</VisuallyHidden>
        <EmptyState
          variant="error"
          title="This sign-in link is incomplete"
          message="Check the address in your email, or request a new one."
          action={{ label: 'Back to sign in', onClick: () => void navigate('/', { replace: true }) }}
        />
      </Box>
    );
  }

  const submit = async () => {
    setNotice(undefined);
    try {
      await redeem.mutateAsync({ token, trustDevice });
      void navigate('/', { replace: true });
    } catch (caught) {
      const uiError = mapError(caught);
      if (isInvalidToken(uiError)) {
        setNotice(authErrorMessage({ ...uiError, code: 'LINK_INVALID_OR_EXPIRED' }));
        return;
      }
      setNotice(authErrorMessage(uiError));
    }
  };

  return (
    <Box component="main" sx={{ maxWidth: 420, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Finish signing in
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 6 }}>
        Confirm below to sign in to your account.
      </Typography>
      <Form label="Confirm sign-in" onSubmit={submit}>
        <FormControlLabel
          control={<Checkbox checked={trustDevice} onChange={(event) => setTrustDevice(event.target.checked)} />}
          label="Keep me signed in on this device"
        />
        {notice !== undefined && <Alert severity="error">{notice}</Alert>}
        <FormError />
        <SubmitButton fullWidth>Continue</SubmitButton>
      </Form>
    </Box>
  );
}
