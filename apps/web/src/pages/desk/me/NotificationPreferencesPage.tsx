import { useDesktopPermission, useEnableDesktopNotifications, useNotificationPreferences, useUpdateNotificationPreferences } from '../../../data/notifications';

import { NotificationPreferencesView } from './NotificationPreferencesView';

/**
 * `/desk/me/notifications` (US15, T245): the container for `NotificationPreferencesView`. Saving
 * sends every event, so the saved choices stay the user's own even if the tenant defaults change
 * later.
 */
export default function NotificationPreferencesPage() {
  const query = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const enableDesktop = useEnableDesktopNotifications();
  const permission = useDesktopPermission();

  const status = query.isPending ? 'pending' : query.isError ? 'error' : 'ready';

  return (
    <NotificationPreferencesView
      status={status}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      preferences={query.data}
      desktopPermission={permission.permission}
      onEnableDesktop={async () => {
        try {
          await enableDesktop.mutateAsync();
        } finally {
          permission.refresh();
        }
      }}
      onSave={async (value) => {
        await update.mutateAsync({ enabled: value.enabled, events: value.events });
      }}
    />
  );
}
