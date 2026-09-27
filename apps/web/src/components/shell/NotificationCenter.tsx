import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useMarkNotificationsRead, useNotificationArrivals, useNotifications, useUnreadNotificationCount } from '../../data/notifications';
import { useRealtime } from '../../data/realtime';
import { WORKSPACE_BASE } from '../../routes/area';
import { formatChatTime } from '../chat/format';
import { EmptyState } from '../foundations/EmptyState';
import { BellIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';
import { Skeleton } from '../foundations/Skeleton';
import { VisuallyHidden } from '../foundations/VisuallyHidden';

import { Modal } from './Modal';

import type { Notification } from '../../data/notifications';

/**
 * The staff notification center (US8, T169, docs/design-system "Workspace Inbox"): a bell button
 * in the workspace top bar with the unread badge, opening a panel of recent notifications with
 * mark-read actions. New arrivals and read-state changes are announced through `LiveRegion`
 * (ui-components rule 3); the cache itself is kept in sync by `useNotificationEvents`, mounted
 * once in `DeskLayout`.
 */

export interface NotificationCenterProps {
  /** Opens the given ticket in the inbox; the caller decides which view it belongs to. */
  onOpenTicket: (ticketId: string) => void;
}

const PANEL_ITEM_LIMIT = 8;

export function NotificationCenter({ onOpenTicket }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const unreadCount = useUnreadNotificationCount();
  const notifications = useNotifications({});
  const markRead = useMarkNotificationsRead();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const client = useRealtime();

  useNotificationArrivals(client, (notification) => {
    announce(`New notification: ${notification.title}`);
  });

  const count = unreadCount.data ?? 0;
  const bellLabel = count > 0 ? `Notifications, ${count} unread` : 'Notifications';

  const openNotification = async (notification: Notification) => {
    if (!notification.read) {
      await markRead.mutateAsync({ ids: [notification.id] });
      announce(`Marked "${notification.title}" as read`);
    }
    if (notification.ticketId !== null) {
      setOpen(false);
      onOpenTicket(notification.ticketId);
    }
  };

  const markAllRead = async () => {
    await markRead.mutateAsync({ all: true });
    announce('Marked all notifications as read');
  };

  const items = notifications.items.slice(0, PANEL_ITEM_LIMIT);

  return (
    <>
      <IconButton aria-label={bellLabel} onClick={() => setOpen(true)}>
        <Badge badgeContent={count} color="error" max={99} overlap="circular">
          <BellIcon />
        </Badge>
      </IconButton>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        maxWidth="sm"
        actions={
          <>
            <Button
              onClick={() => {
                setOpen(false);
                void navigate(`${WORKSPACE_BASE}/notifications`);
              }}
            >
              View all
            </Button>
            <Button variant="contained" disabled={count === 0} onClick={() => void markAllRead()}>
              Mark all read
            </Button>
          </>
        }
      >
        {notifications.isPending ? (
          <Skeleton variant="list" rows={4} label="notifications" />
        ) : notifications.isError ? (
          <EmptyState
            variant="error"
            title="Couldn't load notifications"
            message={notifications.error?.message}
            onRetry={() => void notifications.refetch()}
            headingLevel={3}
          />
        ) : items.length === 0 ? (
          <EmptyState title="No notifications yet" message="You'll see ticket and mention alerts here." headingLevel={3} />
        ) : (
          <List aria-label="Recent notifications" dense sx={{ minWidth: 320 }}>
            {items.map((notification) => (
              <NotificationRow key={notification.id} notification={notification} onOpen={() => void openNotification(notification)} />
            ))}
          </List>
        )}
      </Modal>
    </>
  );
}

export function NotificationRow({ notification, onOpen }: { notification: Notification; onOpen: () => void }) {
  const detail = notification.count > 1 ? `${notification.count} messages` : notification.summary ?? undefined;
  return (
    <ListItem disablePadding>
      <ListItemButton
        alignItems="flex-start"
        onClick={onOpen}
        sx={{ borderRadius: 2, gap: 2, bgcolor: notification.read ? 'transparent' : 'action.selected' }}
      >
        <Box
          aria-hidden="true"
          sx={{ width: 8, height: 8, borderRadius: '50%', mt: 1.5, flexShrink: 0, bgcolor: notification.read ? 'transparent' : 'primary.main' }}
        />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: notification.read ? 400 : 700 }}>
            {!notification.read && <VisuallyHidden>Unread: </VisuallyHidden>}
            {notification.title}
          </Typography>
          {detail !== undefined && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" component="p">
            {formatChatTime(notification.createdAt)}
          </Typography>
        </Box>
      </ListItemButton>
    </ListItem>
  );
}
