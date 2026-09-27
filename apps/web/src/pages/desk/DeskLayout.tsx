import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useCallback, useMemo, useState } from 'react';
import { Navigate, Outlet, useNavigate, useParams } from 'react-router';

import { CommandBar } from '../../components/shell/CommandBar';
import { ConnectionBanner } from '../../components/shell/ConnectionBanner';
import { DesignSystemScope } from '../../components/shell/DesignSystemScope';
import { NotificationCenter } from '../../components/shell/NotificationCenter';
import { useToast } from '../../components/shell/Toast';
import { useMe, useUpdateMe } from '../../data/auth';
import { mapError } from '../../data/errors';
import { useNotificationEvents } from '../../data/notifications';
import { useRealtime } from '../../data/realtime';
import { findTicketByNumber, useTicketListEvents } from '../../data/tickets';
import { useViewCountEvents } from '../../data/view-counts';
import { useViews } from '../../data/views';
import { WORKSPACE_BASE } from '../../routes/area';

import type { Availability } from '../../data/auth';

/**
 * The workspace shell (docs/design-system "Workspace Inbox"): a top bar with the command bar,
 * the signed-in agent's availability and a slot for US8's notifications, then the routed page.
 * Mounts the once-per-app realtime hooks that keep every cached ticket list, view count and
 * notification in sync (`useTicketListEvents`, `useViewCountEvents`, `useNotificationEvents`), so
 * pages below don't each subscribe themselves.
 */

const SKIP_LINK_TARGET = 'desk-main';

const AVAILABILITY_META: Record<Availability, { label: string; color: 'success' | 'warning' | 'default' }> = {
  online: { label: 'Online', color: 'success' },
  away: { label: 'Away', color: 'warning' },
  offline: { label: 'Offline', color: 'default' },
};

export default function DeskLayout() {
  const meQuery = useMe();
  const client = useRealtime();
  const views = useViews();

  useTicketListEvents(client);
  useViewCountEvents(client);
  useNotificationEvents(client);

  const commandBarViews = useMemo(() => (views.data ?? []).map((view) => ({ id: view.id, name: view.name })), [views.data]);
  const navigate = useNavigate();
  const toast = useToast();
  // The current view, when the route below already has one, so a found ticket opens alongside it
  // instead of losing the agent's place; falls back to the first visible view otherwise.
  const routeParams = useParams<{ viewId?: string }>();

  const onOpenTicketNumber = useCallback(
    async (ticketNumber: number) => {
      try {
        const ticket = await findTicketByNumber(ticketNumber);
        const viewId = routeParams.viewId ?? views.data?.[0]?.id;
        if (ticket === undefined || viewId === undefined) {
          toast({ message: `No ticket #${ticketNumber} you can open`, severity: 'info' });
          return;
        }
        void navigate(`${WORKSPACE_BASE}/inbox/${viewId}/${ticket.id}`);
      } catch (caught) {
        toast({ message: mapError(caught).message, severity: 'error' });
      }
    },
    [routeParams.viewId, views.data, navigate, toast],
  );

  const onOpenNotificationTicket = useCallback(
    (ticketId: string) => {
      const viewId = routeParams.viewId ?? views.data?.[0]?.id;
      if (viewId === undefined) return;
      void navigate(`${WORKSPACE_BASE}/inbox/${viewId}/${ticketId}`);
    },
    [routeParams.viewId, views.data, navigate],
  );

  if (meQuery.error?.code === 'UNAUTHENTICATED') {
    return <Navigate to={`${WORKSPACE_BASE}/sign-in`} replace />;
  }

  return (
    <DesignSystemScope>
      <Box
        component="a"
        href={`#${SKIP_LINK_TARGET}`}
        sx={{
          position: 'absolute',
          left: 8,
          top: -80,
          zIndex: 2000,
          px: 3,
          py: 2,
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          color: 'text.primary',
          textDecoration: 'none',
          fontWeight: 600,
          '&:focus-visible': { top: 8 },
        }}
      >
        Skip to content
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <Box
          component="header"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            px: 4,
            py: 2,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            flexShrink: 0,
          }}
        >
          <Typography component="span" variant="h3" sx={{ fontWeight: 700 }}>
            ReplyX
          </Typography>
          <Typography component="span" variant="caption" color="text.secondary" aria-hidden="true">
            Ctrl/⌘ K to jump to a view or ticket
          </Typography>

          <Box sx={{ flex: 1 }} />

          <NotificationCenter onOpenTicket={onOpenNotificationTicket} />

          {meQuery.data !== undefined && <AvailabilityMenu availability={meQuery.data.availability ?? 'online'} />}

          {meQuery.data !== undefined && (
            <Box
              component="button"
              type="button"
              onClick={() => void navigate(`${WORKSPACE_BASE}/me`)}
              aria-label={`Your profile, ${meQuery.data.name}`}
              sx={{ display: 'flex', alignItems: 'center', gap: 2, border: 0, bgcolor: 'transparent', cursor: 'pointer', p: 1, borderRadius: '9999px' }}
            >
              <Avatar src={meQuery.data.avatarUrl ?? undefined} sx={{ width: 32, height: 32, fontSize: '0.8rem' }}>
                {meQuery.data.name.charAt(0).toUpperCase()}
              </Avatar>
            </Box>
          )}
        </Box>

        <ConnectionBanner />

        <Box sx={{ flex: 1, minHeight: 0 }}>
          <Outlet />
        </Box>
      </Box>

      <CommandBar
        views={commandBarViews}
        onSelectView={(viewId) => void navigate(`${WORKSPACE_BASE}/inbox/${viewId}`)}
        onOpenTicketNumber={(ticketNumber) => void onOpenTicketNumber(ticketNumber)}
      />
    </DesignSystemScope>
  );
}

function AvailabilityMenu({ availability }: { availability: Availability }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const updateMe = useUpdateMe();
  const meta = AVAILABILITY_META[availability];

  return (
    <>
      <Chip
        component="button"
        type="button"
        onClick={(event) => setAnchor(event.currentTarget)}
        color={meta.color === 'default' ? undefined : meta.color}
        label={meta.label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        clickable
        sx={{ fontWeight: 600 }}
      />
      <Menu open={anchor !== null} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {(Object.keys(AVAILABILITY_META) as Availability[]).map((value) => (
          <MenuItem
            key={value}
            selected={value === availability}
            onClick={() => {
              setAnchor(null);
              if (value !== availability) void updateMe.mutateAsync({ availability: value });
            }}
          >
            <ListItemIcon>
              <Box
                aria-hidden="true"
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: AVAILABILITY_META[value].color === 'default' ? 'text.disabled' : `${AVAILABILITY_META[value].color}.main`,
                }}
              />
            </ListItemIcon>
            <ListItemText primary={AVAILABILITY_META[value].label} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export { SKIP_LINK_TARGET };
