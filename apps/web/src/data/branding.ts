import { useEffect } from 'react';

import { useGetBranding } from '../api/generated/customer/customer';

import { mapError } from './errors';

import type { RealtimeClient } from './socket';

/**
 * Public workspace branding (`GET /customer/branding`). It answers even while the tenant is
 * suspended, which is how the customer chat knows to show the unavailable page instead of the
 * sign-in flow (FR-004).
 */

export const brandingKeys = {
  all: ['branding'] as const,
};

export function useBranding() {
  const query = useGetBranding({
    query: {
      queryKey: brandingKeys.all,
      // Availability changes rarely and the chat reads it on every load.
      staleTime: 60_000,
    },
  });
  return { ...query, error: query.error ? mapError(query.error) : undefined };
}

/**
 * A socket closed with `TENANT_SUSPENDED` means the workspace went away while the page was open:
 * refetch branding, which flips `available` and sends the chat to the unavailable page.
 */
export function useSuspensionRedirect(client: RealtimeClient | undefined, onSuspended: () => void): void {
  useEffect(() => {
    if (!client) return undefined;
    return client.onClosing((code) => {
      if (code === 'TENANT_SUSPENDED') onSuspended();
    });
  }, [client, onSuspended]);
}
