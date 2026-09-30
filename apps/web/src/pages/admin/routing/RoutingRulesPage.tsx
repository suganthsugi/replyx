import { useMemo } from 'react';

import { useMe } from '../../../data/auth';
import { useGroups } from '../../../data/groups';
import {
  useCreateRoutingRule,
  useDeleteRoutingRule,
  useReorderRoutingRules,
  useRoutingRules,
  useTestRoutingRules,
  useUpdateRoutingRule,
} from '../../../data/routing-rules';
import { useTags } from '../../../data/tags';

import { RoutingRulesView, type RoutingGroupOption } from './RoutingRulesView';

import type { RoutingRule, RoutingRuleInput } from '../../../api/generated/model';

/**
 * Routing rules (US11, FR-059, FR-060): the container. It reads the rules, groups and tags, maps
 * the person's permissions, and hands `RoutingRulesView` plain props and callbacks. The toggle
 * sends the whole rule with `enabled` changed (the API replaces a rule in full).
 */

const NO_RULES: readonly RoutingRule[] = [];

export default function RoutingRulesPage() {
  const rulesQuery = useRoutingRules();
  const groupsQuery = useGroups();
  const tagsQuery = useTags();
  const createRule = useCreateRoutingRule();
  const updateRule = useUpdateRoutingRule();
  const deleteRule = useDeleteRoutingRule();
  const reorderRules = useReorderRoutingRules();
  const testRules = useTestRoutingRules();
  const held = new Set(useMe().data?.permissions ?? []);

  const groups = useMemo<RoutingGroupOption[]>(
    () => (groupsQuery.data ?? []).map((group) => ({ id: group.id, name: group.name, active: group.status === 'active' })),
    [groupsQuery.data],
  );
  const tags = tagsQuery.data ?? [];

  const status = rulesQuery.isPending ? 'pending' : rulesQuery.isError ? 'error' : 'ready';

  return (
    <RoutingRulesView
      status={status}
      errorMessage={rulesQuery.error?.message}
      onRetry={() => void rulesQuery.refetch()}
      rules={rulesQuery.data?.items ?? NO_RULES}
      groups={groups}
      tags={tags}
      lookupsLoading={groupsQuery.isPending || tagsQuery.isPending}
      lookupsFailed={groupsQuery.isError || tagsQuery.isError}
      onRetryLookups={() => {
        void groupsQuery.refetch();
        void tagsQuery.refetch();
      }}
      canCreate={held.has('routing_rule.create')}
      canEdit={held.has('routing_rule.edit')}
      canDelete={held.has('routing_rule.delete')}
      onSave={async (input: RoutingRuleInput, id?: string) => {
        if (id === undefined) await createRule.mutateAsync(input);
        else await updateRule.mutateAsync({ id, body: input });
      }}
      onToggle={async (rule: RoutingRule, enabled: boolean) => {
        await updateRule.mutateAsync({ id: rule.id, body: { name: rule.name, enabled, conditions: rule.conditions, actions: rule.actions } });
      }}
      onReorder={async (ids: string[]) => {
        await reorderRules.mutateAsync(ids);
      }}
      onDelete={async (rule: RoutingRule) => {
        await deleteRule.mutateAsync(rule.id);
      }}
      onTest={(body) => testRules.mutateAsync(body)}
    />
  );
}
