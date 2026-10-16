import { useCallback, useMemo } from 'react';

import { useMe } from '../../../data/auth';
import {
  toAutomationRuleInput,
  useAutomationRules,
  useCreateAutomationRule,
  useDeleteAutomationRule,
  useUpdateAutomationRule,
} from '../../../data/automation-rules';
import { useViewBuilderLookups } from '../../../data/view-builder';

import { AutomationRulesView } from './AutomationRulesView';

import type { AutomationRule, AutomationRuleInput } from '../../../api/generated/model';

/**
 * Automation rules (US17, FR-088, FR-089): the container. It reads the rules and the group, people
 * and tag lists, maps the person's permissions, and hands `AutomationRulesView` plain props. The
 * switch sends the whole rule with `enabled` changed (the API replaces a rule in full).
 */

const NO_RULES: readonly AutomationRule[] = [];

export default function AutomationRulesPage() {
  const rulesQuery = useAutomationRules();
  const lookups = useViewBuilderLookups({ canShare: false });
  const createRule = useCreateAutomationRule();
  const updateRule = useUpdateAutomationRule();
  const deleteRule = useDeleteAutomationRule();
  const held = new Set(useMe().data?.permissions ?? []);

  // Group destinations are the active groups only.
  const groups = useMemo(() => lookups.groups.map((group) => ({ id: group.id, name: group.name, active: true })), [lookups.groups]);
  const people = useMemo(() => lookups.owners.map(({ id, name }) => ({ id, name })), [lookups.owners]);
  const tags = useMemo(() => lookups.tags.map(({ id, name }) => ({ id, name })), [lookups.tags]);
  const { refetch: refetchLookups } = lookups;
  const onRetryLookups = useCallback(() => refetchLookups(), [refetchLookups]);

  const status = rulesQuery.isPending ? 'pending' : rulesQuery.isError ? 'error' : 'ready';

  return (
    <AutomationRulesView
      status={status}
      errorMessage={rulesQuery.error?.message}
      onRetry={() => void rulesQuery.refetch()}
      rules={rulesQuery.data?.items ?? NO_RULES}
      groups={groups}
      people={people}
      tags={tags}
      lookupsLoading={lookups.isLoading}
      lookupsFailed={lookups.isError}
      onRetryLookups={onRetryLookups}
      canCreate={held.has('automation_rule.create')}
      canEdit={held.has('automation_rule.edit')}
      canDelete={held.has('automation_rule.delete')}
      onSave={async (input: AutomationRuleInput, id?: string) => {
        if (id === undefined) await createRule.mutateAsync(input);
        else await updateRule.mutateAsync({ id, body: input });
      }}
      onToggle={async (rule: AutomationRule, enabled: boolean) => {
        await updateRule.mutateAsync({ id: rule.id, body: toAutomationRuleInput(rule, { enabled }) });
      }}
      onDelete={async (rule: AutomationRule) => {
        await deleteRule.mutateAsync(rule.id);
      }}
    />
  );
}
