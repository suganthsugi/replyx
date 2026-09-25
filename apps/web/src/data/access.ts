import { useEffect, useRef } from 'react';

import { meKeys } from './auth';
import { groupKeys } from './groups';
import { roleKeys } from './roles';

import type { RealtimeClient } from './socket';

/**
 * Live access changes for the signed-in staff user (FR-025, contracts/realtime-events.md).
 *
 * - `access.changed` (any role, group access or user role change in the tenant): refetch `/me`
 *   so permission-gated UI updates, plus views, roles, groups and eligible owners.
 * - `access.revoked { ticketIds?, groupIds? }` (this user lost something they had open): screens
 *   showing those tickets or groups close, and the area tells the user why.
 */

/** Query keys of saved views; the views module (US7) owns them. */
const VIEW_KEYS = ['views'] as const;

export interface AccessRevoked {
  ticketIds: string[];
  /** `null` is Ungrouped. */
  groupIds: (string | null)[];
}

export function useAccessChanges(client: RealtimeClient | undefined): void {
  useEffect(() => {
    if (!client) return undefined;
    return client.onEvent('access.changed', (_envelope, queryClient) => {
      for (const queryKey of [meKeys.all, VIEW_KEYS, roleKeys.all, groupKeys.all]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [client]);
}

/**
 * Calls `onRevoked` for every `access.revoked` this user receives. Ticket screens use it to close
 * themselves when their ticket or group is in the payload; the workspace uses it for the notice.
 */
export function useAccessRevoked(client: RealtimeClient | undefined, onRevoked: (revoked: AccessRevoked) => void): void {
  const handler = useRef(onRevoked);
  useEffect(() => {
    handler.current = onRevoked;
  }, [onRevoked]);

  useEffect(() => {
    if (!client) return undefined;
    return client.onEvent('access.revoked', (envelope) => {
      const data = (envelope.data ?? {}) as { ticketIds?: string[]; groupIds?: (string | null)[] };
      handler.current({ ticketIds: data.ticketIds ?? [], groupIds: data.groupIds ?? [] });
    });
  }, [client]);
}
