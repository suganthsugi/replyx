import { useQueryClient } from '@tanstack/react-query';

import {
  useGetTenantSettings as useGetTenantSettingsQuery,
  useUpdateTenantSettings as useUpdateTenantSettingsMutation,
} from '../api/generated/operations/operations';

import { brandingKeys } from './branding';
import { mapError } from './errors';

import type { TenantSettings, TenantSettingsUpdate } from '../api/generated/model';

/**
 * Tenant settings (FR-005): the organization's name, branding, welcome/out-of-hours copy,
 * timezone, self-registration, grace period and after-close/offline behavior, for
 * `OrganizationSettingsPage`. The PATCH sends only changed fields (`TenantSettingsUpdate`); a
 * successful save writes the full response back into the settings cache and invalidates the
 * customer branding query (`branding.ts`) so the chat's name/colors pick up the change.
 *
 * `brandColors.primary` must contrast at least 4.5:1 against white; a failing save comes back as
 * a `VALIDATION_FAILED` error whose `brandColors.primary` field issue is `insufficient_contrast`
 * and whose matching `fieldSuggestions.brandColors.primary` (from `mapError`) is an AA-compliant
 * shade of the same color, for a "Use suggested color" action.
 *
 * Shortening `retentionPeriod` can fail with 409 `RETENTION_CONFIRMATION_REQUIRED`; `mapError` of
 * the thrown error gives `retentionConfirmation: { purgeCount }`. Show "This deletes N closed
 * tickets" and resend the same patch with `confirmPurgeCount: N`. If the count changed meanwhile,
 * the retry fails with the same code and the new `purgeCount`, to be confirmed again.
 */

export const settingsKeys = {
  all: ['settings'] as const,
};

export function useTenantSettings() {
  const query = useGetTenantSettingsQuery({ query: { queryKey: settingsKeys.all } });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

export function useUpdateTenantSettings() {
  const queryClient = useQueryClient();
  const mutation = useUpdateTenantSettingsMutation({
    mutation: {
      onSuccess: (settings) => {
        queryClient.setQueryData(settingsKeys.all, settings);
        void queryClient.invalidateQueries({ queryKey: brandingKeys.all });
      },
    },
  });
  return { ...mutation, mutateAsync: (data: TenantSettingsUpdate) => mutation.mutateAsync({ data }) };
}

export type { TenantSettings, TenantSettingsUpdate };
