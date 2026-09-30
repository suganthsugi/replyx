import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  reorderRoutingRules,
  testRoutingRules,
  updateRoutingRule,
} from '../api/generated/operations/operations';

import { mapError } from './errors';

import type {
  ListRoutingRules200,
  RoutingDryRun,
  RoutingRule,
  RoutingRuleInput,
  TestRoutingRulesBody,
} from '../api/generated/model';

/**
 * Routing rules (US11): the ordered admin list and its mutations. Not realtime, so there is no
 * socket handling. Mutations throw the raw error so the form can map `VALIDATION_FAILED` details
 * (`actions.groupId`, `conditions`) with `mapError`. Components never import `api/generated`.
 */

export const routingRuleKeys = {
  all: ['routing-rules'] as const,
  list: () => [...routingRuleKeys.all, 'list'] as const,
};

const reorderMutationKey = [...routingRuleKeys.all, 'reorder'] as const;

export function useRoutingRules() {
  const query = useQuery<ListRoutingRules200>({
    queryKey: routingRuleKeys.list(),
    queryFn: ({ signal }) => listRoutingRules({ signal }),
    select: (data) => ({ ...data, items: [...data.items].sort((a, b) => a.position - b.position) }),
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidateList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: routingRuleKeys.list() });
}

export function useCreateRoutingRule() {
  const invalidate = useInvalidateList();
  return useMutation<RoutingRule, unknown, RoutingRuleInput>({
    mutationFn: (body) => createRoutingRule(body),
    onSuccess: invalidate,
  });
}

/** Full replace (also the enable toggle). Patches the list cache optimistically and rolls back on error. */
export function useUpdateRoutingRule() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateList();
  return useMutation<
    RoutingRule,
    unknown,
    { id: string; body: RoutingRuleInput },
    { previous: ListRoutingRules200 | undefined }
  >({
    mutationFn: ({ id, body }) => updateRoutingRule(id, body),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey: routingRuleKeys.list() });
      const previous = queryClient.getQueryData<ListRoutingRules200>(routingRuleKeys.list());
      if (previous !== undefined) {
        queryClient.setQueryData<ListRoutingRules200>(routingRuleKeys.list(), {
          ...previous,
          items: previous.items.map((rule) => (rule.id === id ? { ...rule, ...body } : rule)),
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(routingRuleKeys.list(), context.previous);
    },
    onSettled: invalidate,
  });
}

export function useDeleteRoutingRule() {
  const invalidate = useInvalidateList();
  return useMutation<void, unknown, string>({
    mutationFn: (id) => deleteRoutingRule(id),
    onSuccess: invalidate,
  });
}

/** Optimistic reorder of the list cache (positions follow the given id order); rolls back on error. */
export function useReorderRoutingRules() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateList();
  return useMutation<void, unknown, string[], { previous: ListRoutingRules200 | undefined }>({
    mutationKey: reorderMutationKey,
    mutationFn: (ids) => reorderRoutingRules({ ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: routingRuleKeys.list() });
      const previous = queryClient.getQueryData<ListRoutingRules200>(routingRuleKeys.list());
      if (previous !== undefined) {
        const byId = new Map(previous.items.map((rule) => [rule.id, rule]));
        const ordered = ids.flatMap((id) => byId.get(id) ?? []);
        const rest = previous.items.filter((rule) => !ids.includes(rule.id));
        queryClient.setQueryData<ListRoutingRules200>(routingRuleKeys.list(), {
          ...previous,
          items: [...ordered, ...rest].map((rule, position) => ({ ...rule, position })),
        });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(routingRuleKeys.list(), context.previous);
    },
    onSettled: invalidate,
  });
}

/** Dry run of the enabled rules against a sample ticket; no cache writes. */
export function useTestRoutingRules() {
  return useMutation<RoutingDryRun, unknown, TestRoutingRulesBody>({
    mutationFn: (body) => testRoutingRules(body),
  });
}

export type { RoutingDryRun, RoutingRule, RoutingRuleInput, TestRoutingRulesBody };
