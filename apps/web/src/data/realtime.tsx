import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState } from 'react';

import { RealtimeClient, type Namespace, type RealtimeOptions } from './socket';

import type { ReactNode } from 'react';

/**
 * The area's one real-time connection (data-hooks: components never open sockets). An area
 * mounts `RealtimeProvider` with the signed-in user's id; while there is no user there is no
 * socket. Feature hooks take the client from `useRealtime()`.
 */

const RealtimeContext = createContext<RealtimeClient | undefined>(undefined);

export function RealtimeProvider({
  namespace,
  userId,
  children,
  createSocket,
}: {
  namespace: Namespace;
  userId: string | undefined;
  children: ReactNode;
  /** Injected in tests (a fake socket); defaults to a real connection. */
  createSocket?: RealtimeOptions['createSocket'];
}) {
  const queryClient = useQueryClient();
  const [client, setClient] = useState<RealtimeClient | undefined>();

  useEffect(() => {
    if (userId === undefined) return undefined;
    const next = new RealtimeClient({ namespace, userId, queryClient, ...(createSocket === undefined ? {} : { createSocket }) });
    setClient(next);
    return () => {
      next.close();
      setClient(undefined);
    };
  }, [namespace, userId, queryClient, createSocket]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeClient | undefined {
  return useContext(RealtimeContext);
}

/**
 * Called once when the server ends this session over the socket (`SESSION_REVOKED`,
 * `SESSION_EXPIRED`, `TENANT_SUSPENDED`, or a refused handshake).
 */
export function useSessionEnded(client: RealtimeClient | undefined, onEnded: (code: string) => void): void {
  useEffect(() => {
    if (!client) return undefined;
    return client.onClosing(onEnded);
  }, [client, onEnded]);
}
