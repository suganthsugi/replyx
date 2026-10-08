import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  useGetAiSettings,
  useListAiModels,
  useRemoveAiProviderKey as useRemoveAiProviderKeyMutation,
  useSetAiProviderKey as useSetAiProviderKeyMutation,
  useTestAiProviderKey as useTestAiProviderKeyMutation,
  useUpdateAiSettings as useUpdateAiSettingsMutation,
} from '../../api/generated/ai/ai';
import { mapError } from '../errors';

import type { AiSettings, AiSettingsPatch, AiSettingsPausedAnyOfReason, ConnectionTest, ListAiModels200, ModelOption } from '../../api/generated/model';
import type { RealtimeClient } from '../socket';
import type { QueryClient } from '@tanstack/react-query';

/**
 * AI settings (specs/002-ai-assist US1, FR-001 to FR-005): the tenant's settings, the model catalog,
 * and the provider key. The key is write-only: it goes out in `useSaveAiProviderKey` and only
 * `providerKey.last4` ever comes back. Components never import `api/generated/ai` directly
 * (data-hooks rule 6).
 *
 * Real time: `useAiSettingsEvents` applies `ai.paused`/`ai.resumed` (sent on the `user` stream of
 * holders of `ai_settings.manage`) to the cached settings, so the paused banner appears and clears
 * without a reload. The `user` stream's resync keys belong to the notifications hooks, so after a
 * reconnect the settings refetch on their own (mount or window focus) rather than through `sync`.
 */

export const aiSettingsKeys = {
  all: ['ai-settings'] as const,
  settings: () => [...aiSettingsKeys.all, 'settings'] as const,
  models: () => [...aiSettingsKeys.all, 'models'] as const,
};

export type AiPauseReason = AiSettingsPausedAnyOfReason;

/** Needs `ai_settings.manage`; pass `enabled = false` without it. */
export function useAiSettings(enabled = true) {
  const query = useGetAiSettings<AiSettings>({ query: { queryKey: aiSettingsKeys.settings(), enabled } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/** Selectable models per level with prices; the catalog changes only with a deploy. */
export function useAiModels(enabled = true) {
  const query = useListAiModels<ListAiModels200>({ query: { queryKey: aiSettingsKeys.models(), enabled, staleTime: Infinity } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

function setSettings(queryClient: QueryClient, settings: AiSettings): void {
  queryClient.setQueryData(aiSettingsKeys.settings(), settings);
}

export function useUpdateAiSettings() {
  const queryClient = useQueryClient();
  const mutation = useUpdateAiSettingsMutation({ mutation: { onSuccess: (settings) => setSettings(queryClient, settings) } });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: (data: AiSettingsPatch) => mutation.mutateAsync({ data }) };
}

/** Saves or replaces the key; a replace also clears a pause, which the returned settings show. */
export function useSaveAiProviderKey() {
  const queryClient = useQueryClient();
  const mutation = useSetAiProviderKeyMutation({ mutation: { onSuccess: (settings) => setSettings(queryClient, settings) } });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: (apiKey: string) => mutation.mutateAsync({ data: { apiKey } }) };
}

export function useRemoveAiProviderKey() {
  const queryClient = useQueryClient();
  const mutation = useRemoveAiProviderKeyMutation({
    mutation: {
      onSuccess: () => {
        queryClient.setQueryData<AiSettings>(aiSettingsKeys.settings(), (settings) => (settings === undefined ? settings : { ...settings, providerKey: null, paused: null }));
        void queryClient.invalidateQueries({ queryKey: aiSettingsKeys.settings() });
      },
    },
  });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync() };
}

/**
 * Tests the saved key. The result is shown as is (`detail` is plain language); a test can pause or
 * resume AI, so the settings are refetched after it either way.
 */
export function useTestAiProviderKey() {
  const queryClient = useQueryClient();
  const mutation = useTestAiProviderKeyMutation({
    mutation: { onSettled: () => void queryClient.invalidateQueries({ queryKey: aiSettingsKeys.settings() }) },
  });
  return { ...mutation, error: mutation.error ? mapError(mutation.error) : undefined, mutateAsync: () => mutation.mutateAsync() };
}

/** `ai.paused` / `ai.resumed` on the `user` stream; mount where the settings are shown. */
export function useAiSettingsEvents(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    const patch = (queryClient: QueryClient, paused: AiSettings['paused']) =>
      queryClient.setQueryData<AiSettings>(aiSettingsKeys.settings(), (settings) => (settings === undefined ? settings : { ...settings, paused }));
    const off = [
      client.onEvent('ai.paused', (envelope, queryClient) => {
        const { reason } = envelope.data as { reason: AiPauseReason };
        patch(queryClient, { reason, since: envelope.occurredAt });
      }),
      client.onEvent('ai.resumed', (_envelope, queryClient) => patch(queryClient, null)),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe());
  }, [client]);
}

export type { AiSettings, AiSettingsPatch, ConnectionTest, ListAiModels200 as AiModels, ModelOption };
