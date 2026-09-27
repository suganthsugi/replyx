import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { NotificationRow } from '../../../components/shell/NotificationCenter';
import { useMarkNotificationsRead, useNotifications } from '../../../data/notifications';
import { useViews } from '../../../data/views';
import { WORKSPACE_BASE } from '../../../routes/area';

/**
 * The full notification history (US8, T169): every ticket, mention and SLA alert for the signed-in
 * agent, with an unread-only filter and "Mark all read". Opens a notification's ticket in the
 * inbox (falling back to the first visible view, since this page has no view of its own).
 */
export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notifications = useNotifications({ unread: unreadOnly ? true : undefined });
  const markRead = useMarkNotificationsRead();
  const views = useViews();
  const announce = useAnnounce();
  const navigate = useNavigate();

  const openNotification = async (notification: { id: string; title: string; ticketId: string | null; read: boolean }) => {
    if (!notification.read) {
      await markRead.mutateAsync({ ids: [notification.id] });
      announce(`Marked "${notification.title}" as read`);
    }
    const viewId = views.data?.[0]?.id;
    if (notification.ticketId !== null && viewId !== undefined) {
      void navigate(`${WORKSPACE_BASE}/inbox/${viewId}/${notification.ticketId}`);
    }
  };

  const markAllRead = async () => {
    await markRead.mutateAsync({ all: true });
    announce('Marked all notifications as read');
  };

  return (
    <Box component="main" id="desk-main" sx={{ maxWidth: 640, mx: 'auto', p: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, flexWrap: 'wrap', mb: 3 }}>
        <Typography component="h1" variant="h2">
          Notifications
        </Typography>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant={unreadOnly ? 'outlined' : 'contained'}
            size="small"
            onClick={() => setUnreadOnly(false)}
            aria-pressed={!unreadOnly}
          >
            All
          </Button>
          <Button
            variant={unreadOnly ? 'contained' : 'outlined'}
            size="small"
            onClick={() => setUnreadOnly(true)}
            aria-pressed={unreadOnly}
          >
            Unread only
          </Button>
          <Button size="small" onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        </Box>
      </Box>

      {notifications.isPending ? (
        <Skeleton variant="list" rows={8} label="notifications" />
      ) : notifications.isError ? (
        <EmptyState
          variant="error"
          title="Couldn't load notifications"
          message={notifications.error?.message}
          onRetry={() => void notifications.refetch()}
        />
      ) : notifications.items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          message={unreadOnly ? "You're all caught up." : "You'll see ticket and mention alerts here."}
        />
      ) : (
        <>
          <List aria-label="Notifications">
            {notifications.items.map((notification) => (
              <NotificationRow key={notification.id} notification={notification} onOpen={() => void openNotification(notification)} />
            ))}
          </List>
          {notifications.hasNextPage === true && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <Button onClick={() => void notifications.fetchNextPage()} disabled={notifications.isFetchingNextPage}>
                {notifications.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
