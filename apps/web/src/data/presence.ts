import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { groupKeys } from './groups';

import type { RealtimeClient } from './socket';
import type { Availability, EligibleOwner } from '../api/generated/model';

/**
 * Collision awareness and availability (US14). Who is viewing or typing on a ticket comes from
 * `useTicketPresence` / `useTicketTypingIndicator` in `tickets.ts` (re-exported here so presence
 * has one entry point). `useAvailabilityUpdates` (mount once in the workspace shell) applies the
 * ephemeral `availability.changed { userId, availability }` from `tickets:group:*` to every cached
 * eligible-owner list, so owner pickers show the current dot without refetching.
 */

export { useTicketPresence, useTicketTypingIndicator, type TicketPresence, type TicketTypingUser } from './tickets';

interface AvailabilityChanged {
  userId: string;
  availability: Availability;
}

export function useAvailabilityUpdates(client: RealtimeClient | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return undefined;
    return client.onEphemeral('availability.changed', (signal) => {
      const { userId, availability } = signal.data as AvailabilityChanged;
      queryClient.setQueriesData<{ items: EligibleOwner[] }>(
        { predicate: (query) => query.queryKey[0] === groupKeys.all[0] && query.queryKey[1] === 'eligible-owners' },
        (data) =>
          data === undefined || !data.items.some((owner) => owner.id === userId)
            ? data
            : { ...data, items: data.items.map((owner) => (owner.id === userId ? { ...owner, availability } : owner)) },
      );
    });
  }, [client, queryClient]);
}
