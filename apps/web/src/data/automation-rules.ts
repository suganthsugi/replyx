import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createAutomationRule, deleteAutomationRule, listAutomationRules, updateAutomationRule } from '../api/generated/operations/operations';

import { mapError } from './errors';

import type { AutomationRule, AutomationRuleInput, ListAutomationRules200 } from '../api/generated/model';

/**
 * Automation rules (US17, T257): the admin list and its mutations. Not realtime. Mutations throw the
 * raw error so the editor can map `VALIDATION_FAILED` details (`trigger.after`,
 * `actions.ownerId`) with `mapError`. Components never import `api/generated` directly.
 */

export const automationRuleKeys = {
  all: ['automation-rules'] as const,
  list: () => [...automationRuleKeys.all, 'list'] as const,
};

export function useAutomationRules() {
  const query = useQuery<ListAutomationRules200>({
    queryKey: automationRuleKeys.list(),
    queryFn: ({ signal }) => listAutomationRules({ signal }),
    select: (data) => ({ ...data, items: [...data.items].sort((a, b) => a.position - b.position) }),
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidateList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: automationRuleKeys.list() });
}

export function useCreateAutomationRule() {
  const invalidate = useInvalidateList();
  return useMutation<AutomationRule, unknown, AutomationRuleInput>({ mutationFn: (body) => createAutomationRule(body), onSuccess: invalidate });
}

/** Full replace (also the enable switch). */
export function useUpdateAutomationRule() {
  const invalidate = useInvalidateList();
  return useMutation<AutomationRule, unknown, { id: string; body: AutomationRuleInput }>({
    mutationFn: ({ id, body }) => updateAutomationRule(id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteAutomationRule() {
  const invalidate = useInvalidateList();
  return useMutation<void, unknown, string>({ mutationFn: (id) => deleteAutomationRule(id), onSuccess: invalidate });
}

/** The rule as the body of `PUT /automation-rules/{id}` (for the enable switch). */
export function toAutomationRuleInput(rule: AutomationRule, overrides: Partial<AutomationRuleInput> = {}): AutomationRuleInput {
  return { name: rule.name, enabled: rule.enabled, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions, ...overrides };
}

export type { AutomationRule, AutomationRuleInput };
