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
  const client = new RealtimeClient({ namespace: '/', userId: 'u1', queryClient, createSocket: () => socket });
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
    socket.fire('event', envelope('b', 4)); // below the cursor (replayed)
    socket.fire('event', envelope('c', 6));
    expect(seen).toEqual(['a', 'c']);
    expect(client.cursor('user')).toBe(6);
  });

  it('applies a second envelope with the same seq (access.revoked follows access.changed)', () => {
    const { socket, client } = setup();
    const seen: string[] = [];
    client.onEvent('*', (event) => seen.push(event.type));
    socket.fire('event', envelope('changed', 6, 'user', 'access.changed'));
    socket.fire('event', envelope('revoked', 6, 'user', 'access.revoked'));
    expect(seen).toEqual(['access.changed', 'access.revoked']);
    expect(client.cursor('user')).toBe(6);
    expect(JSON.parse(sessionStorage.getItem('rx:rt:cursors:/:u1') ?? '{}')).toEqual({ user: 6 });
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

  it('keeps replayed events when a live event arrives before the replay', async () => {
    const { socket, client } = setup();
    const seen: number[] = [];
    client.onEvent('*', (event) => seen.push(event.seq));
    socket.fire('event', envelope('a', 10));
    socket.acks.sync = () => {
      // The server joined the rooms on connect: a live event beats the replay.
      socket.fire('event', envelope('live', 20));
      socket.fire('event', envelope('r11', 11));
      socket.fire('event', envelope('r19', 19));
      return { ok: true, upToSeq: 19, resyncRequired: [] };
    };

    await socket.open();
    expect(seen).toEqual([10, 11, 19, 20]);
    expect(client.cursor('user')).toBe(20);

    socket.fire('event', envelope('r11', 11)); // already applied
    socket.fire('event', envelope('next', 21));
    expect(seen).toEqual([10, 11, 19, 20, 21]);
  });

  it('restores cursors from sessionStorage', async () => {
    sessionStorage.setItem('rx:rt:cursors:/:u1', JSON.stringify({ views: 9 }));
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

  it('keeps cursors per user', async () => {
    sessionStorage.setItem('rx:rt:cursors:/:someone-else', JSON.stringify({ user: 50 }));
    const { socket, client } = setup();
    expect(client.cursor('user')).toBeUndefined();
    await socket.open();
    expect(socket.emitted.some(([event]) => event === 'sync')).toBe(false);
  });

  it('stops for good when the handshake is refused', () => {
    const { socket, client } = setup();
    const closing = vi.fn();
    client.onClosing(closing);
    socket.fire('connect_error', Object.assign(new Error('Sign in to continue'), { data: { code: 'UNAUTHENTICATED' } }));
    expect(closing).toHaveBeenCalledWith('UNAUTHENTICATED');
    expect(socket.disconnect).toHaveBeenCalled();
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
