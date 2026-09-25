import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Route, Routes } from 'react-router';

import { EmptyState } from '../components/foundations/EmptyState';
import { Skeleton } from '../components/foundations/Skeleton';
import { useCustomerMe } from '../data/customer-auth';
import RedeemLinkPage from '../pages/customer/auth/RedeemLinkPage';
import { SignInFlow } from '../pages/customer/auth/SignInFlow';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The customer chat area (`/` on a tenant host). Loaded lazily and kept free of workspace
 * imports so the customer bundle stays small (research D21) and ticket-free (ui-components
 * rule 5). Chat itself arrives later; for now the signed-in home is a placeholder and the
 * signed-out home is the sign-in flow (T068).
 */
export default function CustomerArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<CustomerHome />} />
        <Route path="sign-in/redeem" element={<RedeemLinkPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}

const SIGNED_OUT_CODES = ['UNAUTHENTICATED', 'NOT_FOUND'];

function CustomerHome() {
  const meQuery = useCustomerMe();

  if (meQuery.isPending) {
    return (
      <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: 4, py: 8 }}>
        <Skeleton variant="block" label="your account" />
      </Box>
    );
  }

  // "No customer is signed in here" arrives as an error: 401 UNAUTHENTICATED without a session,
  // and 404 NOT_FOUND for a staff session (customer routes are hidden from staff). Both mean the
  // sign-in flow, not a failure to report; everything else is a real error with a retry.
  if (meQuery.isError && !SIGNED_OUT_CODES.includes(meQuery.error?.code ?? '')) {
    return (
      <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: 4, py: 8 }}>
        <EmptyState variant="error" title="Couldn't load your account" message={meQuery.error?.message} onRetry={() => void meQuery.refetch()} />
      </Box>
    );
  }

  if (meQuery.data === undefined) {
    return (
      <Box component="main" sx={{ maxWidth: 480, mx: 'auto', px: 4, py: 8 }}>
        <SignInFlow />
      </Box>
    );
  }

  return (
    <Box component="main" sx={{ maxWidth: 720, mx: 'auto', px: 4, py: 8 }}>
      <Typography component="h1" variant="h4">
        Support
      </Typography>
    </Box>
  );
}
