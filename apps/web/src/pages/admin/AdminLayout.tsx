import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { Suspense } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';

import { EmptyState } from '../../components/foundations/EmptyState';
import { Skeleton } from '../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../components/shell/DesignSystemScope';
import { useMe } from '../../data/auth';
import { WORKSPACE_BASE } from '../../routes/area';

/**
 * The admin area (`/desk/admin/*`): a section rail and the section's page. Only the sections the
 * signed-in user may open are listed (FR-071); a section the user can't open is not found, the
 * same as the API answers. Access changes arrive over the socket and refetch `/me`, so the rail
 * follows them without a reload.
 */

export interface AdminSection {
  path: string;
  label: string;
  permission: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { path: 'users', label: 'Users', permission: 'user.view' },
  { path: 'roles', label: 'Roles', permission: 'role.view' },
  { path: 'groups', label: 'Groups', permission: 'group.view' },
  { path: 'support-access', label: 'Support access', permission: 'support_access.view' },
];

const ADMIN_BASE = `${WORKSPACE_BASE}/admin`;

export function visibleSections(permissions: readonly string[]): AdminSection[] {
  const held = new Set(permissions);
  return ADMIN_SECTIONS.filter((section) => held.has(section.permission));
}

export default function AdminLayout() {
  const meQuery = useMe();
  const { pathname } = useLocation();

  if (meQuery.isPending) return <Skeleton variant="block" label="admin area" />;
  if (meQuery.error?.code === 'UNAUTHENTICATED') return <Navigate to={`${WORKSPACE_BASE}/sign-in`} replace />;
  if (meQuery.isError || meQuery.data === undefined) {
    return (
      <EmptyState
        variant="error"
        title="Couldn't load the admin area"
        message={meQuery.error?.message}
        onRetry={() => void meQuery.refetch()}
        headingLevel={1}
      />
    );
  }

  const sections = visibleSections(meQuery.data.permissions);
  const current = pathname.slice(ADMIN_BASE.length + 1).split('/')[0] ?? '';

  if (sections.length === 0) {
    return (
      <Box component="main" sx={{ py: 8 }}>
        <EmptyState title="No admin sections" message="Your roles don't include any administration permissions." headingLevel={1} />
      </Box>
    );
  }
  if (current === '') return <Navigate to={`${ADMIN_BASE}/${sections[0]?.path ?? ''}`} replace />;

  const allowed = sections.some((section) => section.path === current);

  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, minHeight: '100vh' }}>
      <DesignSystemScope fill={false}>
        <Box
          component="nav"
          aria-label="Administration"
          sx={{
            width: { md: 200 },
            minHeight: { md: '100vh' },
            flexShrink: 0,
            bgcolor: 'background.paper',
            // Width by breakpoint, style and color once: a responsive `border*` shorthand resets the color.
            borderStyle: 'solid',
            borderColor: 'divider',
            borderWidth: { xs: '0 0 1px 0', md: '0 1px 0 0' },
            px: 3,
            py: { xs: 2, md: 4 },
          }}
        >
          <Typography variant="overline" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' }, px: 2, mb: 2 }}>
            Admin
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: { xs: 'row', md: 'column' }, gap: 1, overflowX: 'auto' }}>
            {sections.map((section) => (
              <Box component="li" key={section.path} sx={{ flexShrink: 0 }}>
                <Box
                  component={NavLink}
                  to={`${ADMIN_BASE}/${section.path}`}
                  sx={{
                    display: 'block',
                    px: 3,
                    py: 2,
                    borderRadius: 1,
                    color: 'text.primary',
                    textDecoration: 'none',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    '&:hover': { bgcolor: 'action.hover' },
                    // Primary text on primarySoft is under 4.5:1; the soft fill alone marks the section.
                    '&.active': { bgcolor: 'action.selected', fontWeight: 600 },
                    '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
                  }}
                >
                  {section.label}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </DesignSystemScope>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {allowed ? (
          <Suspense fallback={<Skeleton variant="block" label="admin section" />}>
            <Outlet />
          </Suspense>
        ) : (
          <Box component="main" sx={{ py: 8 }}>
            <EmptyState title="Page not found" message="Check the address, or pick a section from the menu." headingLevel={1} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
