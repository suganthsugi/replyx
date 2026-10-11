import { useMe } from '../../../data/auth';
import { useNotificationDefaults, useUpdateNotificationDefaults } from '../../../data/notifications';

import { NotificationDefaultsView } from './NotificationDefaultsView';

/** `/desk/admin/notifications` (US15, T245): the container for `NotificationDefaultsView`. */
export default function NotificationDefaultsPage() {
  const query = useNotificationDefaults();
  const update = useUpdateNotificationDefaults();
  const held = new Set(useMe().data?.permissions ?? []);

  const status = query.isPending ? 'pending' : query.isError ? 'error' : 'ready';

  return (
    <NotificationDefaultsView
      status={status}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      events={query.data?.events}
      canEdit={held.has('tenant_settings.edit')}
      onSave={async (changed) => {
        await update.mutateAsync({ events: changed });
      }}
    />
  );
}
