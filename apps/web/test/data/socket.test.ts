import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeClient, type Envelope, type RealtimeSocket } from '../../src/data/socket';

class FakeSocket implements RealtimeSocket {
  connected = false;
  handlers = new Map<string, ((...args: never[]) => void)[]>();
  emitted: [string, unknown][] = [];
  acks: Record<string, (payload: unknown) => unknown> = {};
  disconnect = vi.fn(() => {
    this.connected = false;
  });

  on(event: string, listener: (...args: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push([event, args[0]]);
  }
  timeout() {
    return {
      emitWithAck: (event: string, payload: unknown) => {
        this.emitted.push([event, payload]);
        const fallback = event === 'sync' ? { ok: true, upToSeq: 0, resyncRequired: [] } : { ok: true };
        return Promise.resolve(this.acks[event]?.(payload) ?? fallback);
      },
    };
  }
  connect() {}
  fire(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
  }
  async open() {
    this.connected = true;
    this.fire('connect');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const envelope = (id: string, seq: number, stream = 'user', type = 'notification.created'): Envelope => ({
  id,
  seq,
  stream,
  type,
  occurredAt: '2026-09-24T10:00:00.000Z',
  actor: { kind: 'system' },
  data: {},
});

function setup() {
  const socket = new FakeSocket();
  const queryClient = new QueryClient();
  const client = new RealtimeClient({ namespace: '/', queryClient, createSocket: () => socket });
  return { socket, queryClient, client };
}

beforeEach(() => sessionStorage.clear());

describe('RealtimeClient', () => {
  it('applies each event once and advances the stream cursor', () => {
    const { socket, client } = setup();
    const seen: string[] = [];
    client.onEvent('*', (event) => seen.push(event.id));
    socket.fire('event', envelope('a', 5));
    socket.fire('event', envelope('a', 5)); // duplicate id
    socket.fire('event', envelope('b', 4)); // at or below the cursor (replayed)
    socket.fire('event', envelope('c', 6));
    expect(seen).toEqual(['a', 'c']);
    expect(client.cursor('user')).toBe(6);
    expect(JSON.parse(sessionStorage.getItem('rx:rt:cursors:/') ?? '{}')).toEqual({ user: 6 });
  });

  it('dispatches by type', () => {
    const { socket, client } = setup();
    const created = vi.fn();
    client.onEvent('notification.created', created);
    socket.fire('event', envelope('a', 1, 'user', 'access.changed'));
    socket.fire('event', envelope('b', 2));
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('syncs its cursors on reconnect, invalidating streams that need a resync', async () => {
    const { socket, client, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    client.registerStreamKeys('tickets', () => [['tickets', 'list']]);
    socket.fire('event', envelope('a', 3, 'user'));
    socket.fire('event', envelope('b', 4, 'tickets'));
    socket.acks.sync = () => ({ ok: true, upToSeq: 20, resyncRequired: ['tickets'] });

    await socket.open();
    expect(socket.emitted).toContainEqual([
      'sync',
      {
        streams: [
          { stream: 'user', afterSeq: 3 },
          { stream: 'tickets', afterSeq: 4 },
        ],
      },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tickets', 'list'] });
    expect(client.cursor('user')).toBe(20);
    expect(client.cursor('tickets')).toBe(20);
  });

  it('restores cursors from sessionStorage', async () => {
    sessionStorage.setItem('rx:rt:cursors:/', JSON.stringify({ views: 9 }));
    const { socket } = setup();
    await socket.open();
    expect(socket.emitted).toContainEqual(['sync', { streams: [{ stream: 'views', afterSeq: 9 }] }]);
  });

  it('re-subscribes ticket streams after a reconnect and reports refusals', async () => {
    const { socket, client } = setup();
    await socket.open();
    await client.subscribe('ticket:t1');
    socket.acks.subscribe = (payload) =>
      (payload as { stream: string }).stream === 'ticket:t2' ? { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } } : { ok: true };
    await expect(client.subscribe('ticket:t2')).rejects.toThrow('NOT_FOUND');

    socket.emitted = [];
    await socket.open();
    expect(socket.emitted).toEqual([['subscribe', { stream: 'ticket:t1' }]]);
  });

  it('stops for good when the server closes the session', () => {
    const { socket, client } = setup();
    const closing = vi.fn();
    client.onClosing(closing);
    socket.fire('closing', { code: 'SESSION_REVOKED' });
    expect(closing).toHaveBeenCalledWith('SESSION_REVOKED');
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
