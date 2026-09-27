import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionBanner } from '../../src/components/shell/ConnectionBanner';
import { RealtimeProvider } from '../../src/data/realtime';
import { renderWithProviders } from '../render';

import type { RealtimeSocket } from '../../src/data/socket';

/**
 * The workspace reconnecting banner (T170): stays hidden through a brief blip, appears (announced
 * politely) once the socket has been down for a moment, and disappears as soon as it reconnects.
 */
class FakeSocket implements RealtimeSocket {
  connected = true;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit() {}
  timeout() {
    return { emitWithAck: () => Promise.resolve({ ok: true, upToSeq: 0, resyncRequired: [] }) };
  }
  connect() {}
  disconnect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
}

function renderBanner(socket: FakeSocket) {
  return renderWithProviders(
    <RealtimeProvider namespace="/" userId="agent-1" createSocket={() => socket}>
      <ConnectionBanner />
    </RealtimeProvider>,
  );
}

describe('ConnectionBanner', () => {
  afterEach(() => vi.useRealTimers());

  it('stays hidden while connected', async () => {
    const socket = new FakeSocket();
    renderBanner(socket);
    await waitFor(() => expect(socket.handlers.get('connect')).toBeDefined());
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it('shows the banner, announced politely, only after a delay disconnected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = new FakeSocket();
    const { container } = renderBanner(socket);

    socket.connected = false;
    act(() => socket.fire('disconnect'));

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getAllByText(/Reconnecting/).length).toBeGreaterThan(0);
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent(/Reconnecting/);
  });

  it('stays hidden during a slow first connect (nothing to reconnect yet)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = new FakeSocket();
    socket.connected = false;
    renderBanner(socket);

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it('hides again as soon as it reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = new FakeSocket();
    renderBanner(socket);

    socket.connected = false;
    act(() => socket.fire('disconnect'));
    await act(() => vi.advanceTimersByTimeAsync(1600));
    expect(screen.getAllByText(/Reconnecting/).length).toBeGreaterThan(0);

    socket.connected = true;
    act(() => socket.fire('connect'));
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });
});
