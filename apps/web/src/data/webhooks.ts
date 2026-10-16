import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createWebhook, deleteWebhook, listWebhookDeliveries, listWebhooks, rotateWebhookSecret, updateWebhook } from '../api/generated/operations/operations';

import { mapError } from './errors';

import type { ListWebhooks200, Webhook, WebhookDelivery, WebhookEvent, WebhookInput, WebhookWithSecret } from '../api/generated/model';

/**
 * Webhooks (US18, T263): endpoints, their mutations and each endpoint's delivery history. Not
 * realtime: the history has a refresh button. Create and rotate return the signing secret once;
 * callers show it and never keep it. Mutations throw the raw error so forms can map
 * `VALIDATION_FAILED` details (`url`, `events`) with `mapError`.
 */

export const webhookKeys = {
  all: ['webhooks'] as const,
  list: () => [...webhookKeys.all, 'list'] as const,
  deliveries: (id: string) => [...webhookKeys.all, 'deliveries', id] as const,
};

export function useWebhooks() {
  const query = useQuery<ListWebhooks200>({ queryKey: webhookKeys.list(), queryFn: ({ signal }) => listWebhooks({ signal }) });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

function useInvalidateList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: webhookKeys.list() });
}

export function useCreateWebhook() {
  const invalidate = useInvalidateList();
  return useMutation<WebhookWithSecret, unknown, WebhookInput>({ mutationFn: (body) => createWebhook(body), onSuccess: invalidate });
}

/** Full replace (also the on/off switch). */
export function useUpdateWebhook() {
  const invalidate = useInvalidateList();
  return useMutation<Webhook, unknown, { id: string; body: WebhookInput }>({ mutationFn: ({ id, body }) => updateWebhook(id, body), onSuccess: invalidate });
}

export function useDeleteWebhook() {
  const invalidate = useInvalidateList();
  return useMutation<void, unknown, string>({ mutationFn: (id) => deleteWebhook(id), onSuccess: invalidate });
}

export function useRotateWebhookSecret() {
  return useMutation<{ secret: string }, unknown, string>({ mutationFn: (id) => rotateWebhookSecret(id) });
}

/** One endpoint's attempts, newest first, cursor-paged; only fetched while `id` is set. */
export function useWebhookDeliveries(id: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: webhookKeys.deliveries(id ?? ''),
    queryFn: ({ pageParam, signal }) => listWebhookDeliveries(id as string, { cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: id !== undefined,
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** The endpoint as the body of `PUT /webhooks/{id}` (for the switch). */
export function toWebhookInput(webhook: Webhook, overrides: Partial<WebhookInput> = {}): WebhookInput {
  return { url: webhook.url, events: webhook.events, enabled: webhook.enabled, ...overrides };
}

export type { Webhook, WebhookDelivery, WebhookEvent, WebhookInput };
