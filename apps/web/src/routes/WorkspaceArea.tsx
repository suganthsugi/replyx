import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback } from 'react';
import { Route, Routes, useNavigate } from 'react-router';

import { Skeleton } from '../components/foundations/Skeleton';
import { useToast } from '../components/shell/Toast';
import { useAccessChanges, useAccessRevoked } from '../data/access';
import { useKnownMe } from '../data/auth';
import { RealtimeProvider, useRealtime, useSessionEnded } from '../data/realtime';
import AcceptInvitationPage from '../pages/desk/auth/AcceptInvitationPage';
import ForgotPasswordPage from '../pages/desk/auth/ForgotPasswordPage';
import ResetPasswordPage from '../pages/desk/auth/ResetPasswordPage';
import SignInPage from '../pages/desk/auth/SignInPage';
import ProfilePage from '../pages/desk/me/ProfilePage';

import { WORKSPACE_BASE } from './area';
import { AreaShell, NotFoundPage } from './AreaShell';

import type { ReactNode } from 'react';

// The admin area is its own chunk: most workspace users never open it.
const AdminLayout = lazy(() => import('../pages/admin/AdminLayout'));
const UsersPage = lazy(() => import('../pages/admin/users/UsersPage'));
const RolesPage = lazy(() => import('../pages/admin/roles/RolesPage'));
const RoleEditorPage = lazy(() => import('../pages/admin/roles/RoleEditorPage'));
const GroupsPage = lazy(() => import('../pages/admin/groups/GroupsPage'));
const SupportAccessPage = lazy(() => import('../pages/admin/support-access/SupportAccessPage'));

/**
 * The agent/admin workspace (`/desk/*` on a tenant host), loaded lazily. Paths here are relative
 * to `/desk`. Admin sections live under `/desk/admin` in `AdminLayout` (T100).
 */
export default function WorkspaceArea() {
  return (
    <AreaShell>
      <StaffRealtime>
        <Routes>
          <Route index element={<WorkspaceHome />} />
          <Route path="sign-in" element={<SignInPage />} />
          <Route path="accept-invitation" element={<AcceptInvitationPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="me" element={<ProfilePage />} />
          <Route
            path="admin"
            element={
              <Suspense fallback={<Skeleton variant="block" label="admin area" />}>
                <AdminLayout />
              </Suspense>
            }
          >
            <Route path="users" element={<UsersPage />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="roles/:id" element={<RoleEditorPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="support-access" element={<SupportAccessPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </StaffRealtime>
    </AreaShell>
  );
}

/**
 * Opens the staff socket once the page knows who is signed in, and ends the page's session when
 * the server ends it: a revoked session or a suspended workspace goes back to sign-in (FR-004).
 */
function StaffRealtime({ children }: { children: ReactNode }) {
  const me = useKnownMe();
  return (
    <RealtimeProvider namespace="/" userId={me?.id}>
      <StaffSessionEvents />
      {children}
    </RealtimeProvider>
  );
}

function StaffSessionEvents() {
  const client = useRealtime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  useAccessChanges(client);
  useAccessRevoked(
    client,
    useCallback(() => toast({ message: 'Your access changed. Some tickets or groups are no longer available to you.', severity: 'info' }), [toast]),
  );
  useSessionEnded(
    client,
    useCallback(
      (code: string) => {
        queryClient.clear();
        toast({
          message: code === 'TENANT_SUSPENDED' ? 'This workspace is currently unavailable.' : 'You have been signed out.',
          severity: 'info',
        });
        void navigate(`${WORKSPACE_BASE}/sign-in`, { replace: true });
      },
      [queryClient, toast, navigate],
    ),
  );
  return null;
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
