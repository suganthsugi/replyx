import { useMemo } from 'react';

import { positionChanges, slaPolicyToBody, type CalendarOption, type SlaPolicyBody, type SlaPolicyRecord } from '../../../components/builders/sla-policy-model';
import { useMe } from '../../../data/auth';
import { useGroups } from '../../../data/groups';
import { useBusinessHoursList, useCreateSlaPolicy, useDeleteSlaPolicy, useSlaPolicies, useUpdateSlaPolicy } from '../../../data/sla';

import { SlaPoliciesView } from './SlaPoliciesView';

/**
 * SLA policies (US12, FR-084): the container. It reads the policies, calendars and groups, maps
 * the person's permissions, and hands `SlaPoliciesView` plain props and callbacks. There is no
 * reorder route: a move rewrites `position` (0..n-1) on the policies whose place changed, one
 * replace at a time.
 */

const NO_POLICIES: readonly SlaPolicyRecord[] = [];

export default function SlaPoliciesPage() {
  const policiesQuery = useSlaPolicies();
  const calendarsQuery = useBusinessHoursList();
  const groupsQuery = useGroups();
  const createPolicy = useCreateSlaPolicy();
  const updatePolicy = useUpdateSlaPolicy();
  const deletePolicy = useDeleteSlaPolicy();
  const held = new Set(useMe().data?.permissions ?? []);

  const calendars = useMemo<CalendarOption[]>(() => (calendarsQuery.data?.items ?? []).map((calendar) => ({ id: calendar.id, name: calendar.name })), [calendarsQuery.data]);
  const groups = useMemo(
    () => (groupsQuery.data ?? []).map((group) => ({ id: group.id, name: group.status === 'active' ? group.name : `${group.name} (inactive)` })),
    [groupsQuery.data],
  );

  const status = policiesQuery.isPending ? 'pending' : policiesQuery.isError ? 'error' : 'ready';

  return (
    <SlaPoliciesView
      status={status}
      errorMessage={policiesQuery.error?.message}
      onRetry={() => void policiesQuery.refetch()}
      policies={policiesQuery.data?.items ?? NO_POLICIES}
      calendars={calendars}
      groups={groups}
      lookupsLoading={calendarsQuery.isPending || groupsQuery.isPending}
      lookupsFailed={calendarsQuery.isError || groupsQuery.isError}
      onRetryLookups={() => {
        void calendarsQuery.refetch();
        void groupsQuery.refetch();
      }}
      canCreate={held.has('sla_policy.create')}
      canEdit={held.has('sla_policy.edit')}
      canDelete={held.has('sla_policy.delete')}
      onSave={async (body: SlaPolicyBody, id?: string) => {
        if (id === undefined) await createPolicy.mutateAsync(body);
        else await updatePolicy.mutateAsync({ id, body });
      }}
      onReorder={async (ordered: SlaPolicyRecord[]) => {
        for (const { policy, position } of positionChanges(ordered)) {
          await updatePolicy.mutateAsync({ id: policy.id, body: slaPolicyToBody(policy, position) });
        }
      }}
      onDelete={async (policy: SlaPolicyRecord) => {
        await deletePolicy.mutateAsync(policy.id);
      }}
    />
  );
}
