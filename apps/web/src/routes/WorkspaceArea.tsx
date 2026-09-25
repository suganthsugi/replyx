import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Route, Routes } from 'react-router';

import UsersPage from '../pages/admin/users/UsersPage';
import AcceptInvitationPage from '../pages/desk/auth/AcceptInvitationPage';
import ForgotPasswordPage from '../pages/desk/auth/ForgotPasswordPage';
import ResetPasswordPage from '../pages/desk/auth/ResetPasswordPage';
import SignInPage from '../pages/desk/auth/SignInPage';
import ProfilePage from '../pages/desk/me/ProfilePage';

import { AreaShell, NotFoundPage } from './AreaShell';

/**
 * The agent/admin workspace (`/desk/*` on a tenant host), loaded lazily. Paths here are relative
 * to `/desk`. Admin sections live under `/desk/admin` (T067, T069).
 */
export default function WorkspaceArea() {
  return (
    <AreaShell>
      <Routes>
        <Route index element={<WorkspaceHome />} />
        <Route path="sign-in" element={<SignInPage />} />
        <Route path="accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        <Route path="me" element={<ProfilePage />} />
        <Route path="admin/users" element={<UsersPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AreaShell>
  );
}

function WorkspaceHome() {
  return (
    <Box component="main" sx={{ px: 6, py: 6 }}>
      <Typography component="h1" variant="h4">
        Inbox
      </Typography>
    </Box>
  );
}
