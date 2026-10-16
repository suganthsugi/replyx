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
  /** Relative to the admin base; may be nested (`ai/policies`). */
  path: string;
  label: string;
  permission: string;
  /** Listed under this heading in the rail, after the ungrouped sections. */
  group?: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { path: 'users', label: 'Users', permission: 'user.view' },
  { path: 'roles', label: 'Roles', permission: 'role.view' },
  { path: 'groups', label: 'Groups', permission: 'group.view' },
  { path: 'routing', label: 'Routing rules', permission: 'routing_rule.view' },
  { path: 'automation', label: 'Automation rules', permission: 'automation_rule.view' },
  { path: 'webhooks', label: 'Webhooks', permission: 'webhook.view' },
  { path: 'macros', label: 'Macros', permission: 'macro.view' },
  { path: 'sla-policies', label: 'SLA policies', permission: 'sla_policy.view' },
  { path: 'business-hours', label: 'Business hours', permission: 'sla_policy.view' },
  { path: 'support-access', label: 'Support access', permission: 'support_access.view' },
  { path: 'settings', label: 'Organization', permission: 'tenant_settings.view' },
  { path: 'notifications', label: 'Notification defaults', permission: 'tenant_settings.view' },
  { path: 'audit', label: 'Audit log', permission: 'audit_log.view' },
  { path: 'ai', label: 'AI settings', permission: 'ai_settings.manage', group: 'AI' },
  { path: 'ai/policies', label: 'Policies', permission: 'ai_knowledge.manage', group: 'AI' },
  { path: 'ai/complexity', label: 'Complexity', permission: 'ai_settings.manage', group: 'AI' },
  { path: 'ai/usage', label: 'Usage', permission: 'ai_usage.view', group: 'AI' },
];

const ADMIN_BASE = `${WORKSPACE_BASE}/admin`;

export function visibleSections(permissions: readonly string[]): AdminSection[] {
  const held = new Set(permissions);
  return ADMIN_SECTIONS.filter((section) => held.has(section.permission));
}

/** The section a path below the admin base belongs to: the longest matching section path. */
export function sectionFor(sections: readonly AdminSection[], subPath: string): AdminSection | undefined {
  return sections
    .filter((section) => subPath === section.path || subPath.startsWith(`${section.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** `ai` must not stay highlighted on `ai/policies`; `roles` must on `roles/:id`. */
function hasNestedSections(section: AdminSection): boolean {
  return ADMIN_SECTIONS.some((other) => other.path.startsWith(`${section.path}/`));
}

/** Ungrouped sections first, then each group in order of first appearance. */
function railGroups(sections: readonly AdminSection[]): { heading?: string; sections: AdminSection[] }[] {
  const groups: { heading?: string; sections: AdminSection[] }[] = [{ sections: sections.filter((s) => s.group === undefined) }];
  for (const section of sections) {
    if (section.group === undefined) continue;
    const existing = groups.find((g) => g.heading === section.group);
    if (existing === undefined) groups.push({ heading: section.group, sections: [section] });
    else existing.sections.push(section);
  }
  return groups.filter((g) => g.sections.length > 0);
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
  const subPath = pathname.slice(ADMIN_BASE.length + 1).replace(/\/$/, '');

  if (sections.length === 0) {
    return (
      <Box component="main" sx={{ py: 8 }}>
        <EmptyState title="No admin sections" message="Your roles don't include any administration permissions." headingLevel={1} />
      </Box>
    );
  }
  if (subPath === '') return <Navigate to={`${ADMIN_BASE}/${sections[0]?.path ?? ''}`} replace />;

  // Matched against every section, not just the visible ones, so `ai/usage` without its
  // permission is not found rather than falling back to `ai`.
  const current = sectionFor(ADMIN_SECTIONS, subPath);
  const allowed = current !== undefined && sections.includes(current);

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
          {railGroups(sections).map((group) => (
            <Box key={group.heading ?? ''} sx={{ '& + &': { mt: { xs: 1, md: 4 } } }}>
              <Typography variant="overline" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' }, px: 2, mb: 2 }}>
                {group.heading ?? 'Admin'}
              </Typography>
              <Box
                component="ul"
                aria-label={group.heading}
                sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: { xs: 'row', md: 'column' }, gap: 1, overflowX: 'auto' }}
              >
                {group.sections.map((section) => (
                  <Box component="li" key={section.path} sx={{ flexShrink: 0 }}>
                    <Box
                      component={NavLink}
                      to={`${ADMIN_BASE}/${section.path}`}
                      end={hasNestedSections(section)}
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
          ))}
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
