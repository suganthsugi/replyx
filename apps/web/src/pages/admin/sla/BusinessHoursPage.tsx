import { useMe } from '../../../data/auth';
import { useBusinessHoursList, useCreateBusinessHours, useDeleteBusinessHours, useUpdateBusinessHours } from '../../../data/sla';

import { BusinessHoursView, type BusinessHoursBody, type BusinessHoursRecord } from './BusinessHoursView';

/**
 * Business hours (US12, FR-085): the container. It reads the calendars, maps the person's
 * permissions, and hands `BusinessHoursView` plain props and callbacks.
 */

const NO_CALENDARS: readonly BusinessHoursRecord[] = [];

export default function BusinessHoursPage() {
  const query = useBusinessHoursList();
  const createCalendar = useCreateBusinessHours();
  const updateCalendar = useUpdateBusinessHours();
  const deleteCalendar = useDeleteBusinessHours();
  const held = new Set(useMe().data?.permissions ?? []);

  const status = query.isPending ? 'pending' : query.isError ? 'error' : 'ready';

  return (
    <BusinessHoursView
      status={status}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      calendars={query.data?.items ?? NO_CALENDARS}
      canCreate={held.has('sla_policy.create')}
      canEdit={held.has('sla_policy.edit')}
      canDelete={held.has('sla_policy.delete')}
      onSave={async (body: BusinessHoursBody, id?: string) => {
        if (id === undefined) await createCalendar.mutateAsync(body);
        else await updateCalendar.mutateAsync({ id, body });
      }}
      onDelete={async (calendar: BusinessHoursRecord) => {
        await deleteCalendar.mutateAsync(calendar.id);
      }}
    />
  );
}
