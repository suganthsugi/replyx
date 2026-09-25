import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { useRequestSignInLink } from '../../../data/customer-auth';

export interface CheckEmailStepProps {
  email: string;
  onChangeEmail: () => void;
  onUsePassword: () => void;
}

/** Tells the customer their sign-in link is on its way, with a way to resend or start over. */
export function CheckEmailStep({ email, onChangeEmail, onUsePassword }: CheckEmailStepProps) {
  const requestLink = useRequestSignInLink();
  const announce = useAnnounce();
  const [resent, setResent] = useState(false);

  const resend = async () => {
    await requestLink.mutateAsync({ email });
    setResent(true);
    announce('A new sign-in link is on its way.');
  };

  return (
    <Box>
      <Typography component="h1" variant="h4" sx={{ mb: 2 }}>
        Check your email
      </Typography>
      <Typography sx={{ mb: 6 }}>
        We sent a sign-in link to <strong>{email}</strong>. Open it on this device to continue — it works once and
        expires in 15 minutes.
      </Typography>
      <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={requestLink.isPending}
          onClick={() => void resend()}
        >
          Resend the link
        </Button>
        <Button variant="text" onClick={onChangeEmail}>
          Use a different email
        </Button>
      </Box>
      {resent && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
          Sent again — check your inbox.
        </Typography>
      )}
      {requestLink.isError && (
        <Alert severity="error" sx={{ mt: 3 }}>
          Couldn&apos;t resend the link. Try again in a moment.
        </Alert>
      )}
      <Box sx={{ mt: 6, textAlign: 'center' }}>
        <Link component="button" type="button" onClick={onUsePassword}>
          Sign in with a password instead
        </Link>
      </Box>
    </Box>
  );
}
