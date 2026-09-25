import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RealtimeProvider, useRealtime, useSessionEnded } from '../../src/data/realtime';
import { RealtimeClient, type RealtimeSocket } from '../../src/data/socket';

/**
 * The staff and customer areas both end the page's session when the server closes the socket
 * (`WorkspaceArea`'s `StaffSessionEvents`, `CustomerArea`'s `CustomerSessionEvents`): a revoked
 * session or a suspended workspace fires `closing { code }`, and `useSessionEnded` is the one
 * hook both areas build their handling on. Exercised here with a fake socket (web-testing rule
 * 8) rather than the inert one `socket.io-client` is mocked to globally.
 */

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  disconnect = vi.fn();
  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout() {
    return { emitWithAck: () => Promise.resolve({ ok: true }) };
  }
  connect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

function Harness({ client, onEnded }: { client: RealtimeClient; onEnded: (code: string) => void }) {
  useSessionEnded(client, onEnded);
  return null;
}

describe('useSessionEnded', () => {
  it('calls the handler once with the code the server closed the socket with', () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => socket });
    const onEnded = vi.fn();

    render(<Harness client={client} onEnded={onEnded} />);
    act(() => socket.fire('closing', { code: 'SESSION_REVOKED' }));

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith('SESSION_REVOKED');
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('stops listening once the component unmounts', () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const client = new RealtimeClient({ namespace: '/customer', userId: 'c1', queryClient, createSocket: () => socket });
    const onEnded = vi.fn();

    const { unmount } = render(<Harness client={client} onEnded={onEnded} />);
    unmount();
    act(() => socket.fire('closing', { code: 'TENANT_SUSPENDED' }));

    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe('RealtimeProvider', () => {
  it('opens no client while there is no signed-in user, and one once there is', () => {
    const queryClient = new QueryClient();
    let seen: unknown;
    function Probe() {
      seen = useRealtime();
      return null;
    }
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider namespace="/" userId={undefined}>
          <Probe />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(seen).toBeUndefined();

    rerender(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider namespace="/" userId="u1">
          <Probe />
        </RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(seen).toBeInstanceOf(RealtimeClient);
  });
});
