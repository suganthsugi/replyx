import { io } from 'socket.io-client';

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * The one real-time connection per area (research D8, contracts/realtime-events.md): staff on
 * namespace `/`, customers on `/customer`, Socket.IO path `/rt`, same origin (the tenant host).
 *
 * Persistent events arrive as `event` envelopes `{ id, seq, stream, type, occurredAt, actor,
 * data }`. The client keeps the last applied `seq` per stream (memory + sessionStorage) and:
 * - drops envelopes it has already applied (same `id`, or `seq` at or below the cursor);
 * - on every (re)connect sends `sync { streams: [{ stream, afterSeq }] }`, which replays what it
 *   missed; streams the server lists in `resyncRequired` have their queries invalidated instead.
 *   Until the sync is answered, every envelope (replayed or live) is buffered and then applied in
 *   `seq` order against the cursors sent, so a live event can't push the cursor past a replay;
 * - re-subscribes `ticket:{id}` streams after a reconnect (rooms don't survive one);
 * - on `closing { code }` (session revoked or expired, tenant suspended), or a refused handshake
 *   (`connect_error` with `data.code`), stops reconnecting and tells listeners, so the app can
 *   return to sign-in.
 *
 * Feature hooks register how a stream maps to query keys (`registerStreamKeys`) and listen for
 * event types (`onEvent`) to patch the cache; components never open sockets.
 */

export type Namespace = '/' | '/customer';

export interface Envelope<D = unknown> {
  id: string;
  seq: number;
  stream: string;
  type: string;
  occurredAt: string;
  actor: { kind: string; id?: string; name?: string };
  data: D;
}

export type SyncAck =
  | { ok: true; upToSeq: number; resyncRequired: string[] }
  | { ok: false; error: { code: string; message: string } };

export type SubscribeAck = { ok: true } | { ok: false; error: { code: string; message: string } };

export type EventListener = (envelope: Envelope, queryClient: QueryClient) => void;
export type ClosingListener = (code: string) => void;

/** The socket.io-client surface this module uses (a fake in tests). */
export interface RealtimeSocket {
  connected: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
  connect(): unknown;
  disconnect(): unknown;
}

export const REALTIME_PATH = '/rt';
const ACK_TIMEOUT_MS = 10_000;
const MAX_APPLIED_IDS = 1_000;

/** Per user, so someone else signing in on the same tab never inherits these cursors. */
function storageKey(namespace: Namespace, userId: string): string {
  return `rx:rt:cursors:${namespace}:${userId}`;
}

function loadCursors(key: string): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return new Map();
  }
}

export interface RealtimeOptions {
  namespace: Namespace;
  /** The signed-in user (from `/me`); cursors are stored per user. */
  userId: string;
  queryClient: QueryClient;
  /** Injected in tests; defaults to a real socket.io-client connection. */
  createSocket?: (namespace: Namespace) => RealtimeSocket;
}

export class RealtimeClient {
  readonly namespace: Namespace;
  private readonly queryClient: QueryClient;
  private readonly socket: RealtimeSocket;
  private readonly cursors: Map<string, number>;
  private readonly storageKey: string;
  private readonly applied = new Set<string>();
  private readonly subscriptions = new Set<string>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly closingListeners = new Set<ClosingListener>();
  private readonly streamKeys = new Map<string, (stream: string) => QueryKey[]>();
  private closed = false;
  /** Envelopes received while a `sync` is in flight; applied once it is answered. */
  private buffered: Envelope[] | undefined;

  constructor(options: RealtimeOptions) {
    this.namespace = options.namespace;
    this.queryClient = options.queryClient;
    this.storageKey = storageKey(options.namespace, options.userId);
    this.cursors = loadCursors(this.storageKey);
    this.socket = (options.createSocket ?? defaultSocket)(options.namespace);
    this.socket.on('connect', () => void this.onConnect());
    this.socket.on('event', (envelope: Envelope) => this.onEnvelope(envelope));
    this.socket.on('closing', (body: { code?: string }) => this.handleClosing(body.code ?? 'UNAUTHENTICATED'));
    // A handshake the server refuses is final (Socket.IO does not retry middleware errors).
    this.socket.on('connect_error', (error: { data?: { code?: unknown } }) => {
      const code = error.data?.code;
      if (typeof code === 'string') this.handleClosing(code);
    });
  }

  /** Called with every newly applied envelope of `type` (`*` for all). Returns an unsubscribe. */
  onEvent(type: string, listener: EventListener): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => set.delete(listener);
  }

  /** Called with the code when the server ends this session (`SESSION_REVOKED`, ...). */
  onClosing(listener: ClosingListener): () => void {
    this.closingListeners.add(listener);
    return () => this.closingListeners.delete(listener);
  }

  /**
   * Maps a stream (by its name before any `:`, e.g. `ticket` or `tickets`) to the query keys to
   * invalidate when its events can't be replayed.
   */
  registerStreamKeys(prefix: string, keys: (stream: string) => QueryKey[]): void {
    this.streamKeys.set(prefix, keys);
  }

  /** Joins `ticket:{id}` (staff); rejects with the ack error (`NOT_FOUND` when not visible). */
  async subscribe(stream: string): Promise<void> {
    this.subscriptions.add(stream);
    if (!this.socket.connected) return;
    const ack = (await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('subscribe', { stream })) as SubscribeAck;
    if (!ack.ok) {
      this.subscriptions.delete(stream);
      throw new Error(ack.error.code);
    }
  }

  unsubscribe(stream: string): void {
    this.subscriptions.delete(stream);
    if (this.socket.connected) this.socket.emit('unsubscribe', { stream });
  }

  cursor(stream: string): number | undefined {
    return this.cursors.get(stream);
  }

  close(): void {
    this.closed = true;
    this.socket.disconnect();
  }

  private async onConnect(): Promise<void> {
    if (this.closed) return;
    // The server joins this socket's rooms on connect, so live events can arrive before the
    // replay: hold everything until the sync is answered.
    const syncFrom = new Map(this.cursors);
    if (syncFrom.size > 0) this.buffered = [];
    try {
      await this.resubscribeAndSync(syncFrom);
    } finally {
      this.flush(syncFrom);
    }
  }

  private async resubscribeAndSync(syncFrom: ReadonlyMap<string, number>): Promise<void> {
    for (const stream of this.subscriptions) {
      await this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck('subscribe', { stream })
        .catch(() => undefined);
    }
    if (syncFrom.size === 0) return;
    const streams = [...syncFrom].map(([stream, afterSeq]) => ({ stream, afterSeq }));
    let ack: SyncAck;
    try {
      ack = (await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck('sync', { streams })) as SyncAck;
    } catch {
      // No answer: refetch everything we track rather than show stale data.
      this.resync(streams.map((entry) => entry.stream));
      return;
    }
    if (!ack.ok) {
      this.resync(streams.map((entry) => entry.stream));
      return;
    }
    this.resync(ack.resyncRequired);
    for (const { stream } of streams) {
      // Everything up to upToSeq was replayed (or refetched); newer events arrive live.
      this.setCursor(stream, Math.max(this.cursors.get(stream) ?? 0, ack.upToSeq));
    }
  }

  /** Applies the envelopes held during a sync, oldest first, against the cursors that were sent. */
  private flush(syncFrom: ReadonlyMap<string, number>): void {
    const held = this.buffered ?? [];
    this.buffered = undefined;
    held.sort((a, b) => a.seq - b.seq);
    for (const envelope of held) this.apply(envelope, syncFrom.get(envelope.stream));
  }

  private handleClosing(code: string): void {
    // The server is about to disconnect this session for good: don't reconnect.
    this.closed = true;
    this.socket.disconnect();
    for (const listener of this.closingListeners) listener(code);
  }

  private onEnvelope(envelope: Envelope): void {
    if (this.buffered !== undefined) {
      this.buffered.push(envelope);
      return;
    }
    this.apply(envelope, this.cursors.get(envelope.stream));
  }

  /** Applies an envelope unless it was already applied or is at or below `floor`. */
  private apply(envelope: Envelope, floor: number | undefined): void {
    if (this.applied.has(envelope.id)) return;
    if (floor !== undefined && envelope.seq <= floor) return;
    this.markApplied(envelope.id);
    this.setCursor(envelope.stream, Math.max(this.cursors.get(envelope.stream) ?? 0, envelope.seq));
    for (const type of [envelope.type, '*']) {
      for (const listener of this.listeners.get(type) ?? []) listener(envelope, this.queryClient);
    }
  }

  private resync(streams: readonly string[]): void {
    for (const stream of streams) {
      const prefix = stream.split(':')[0] ?? stream;
      for (const queryKey of this.streamKeys.get(prefix)?.(stream) ?? []) {
        void this.queryClient.invalidateQueries({ queryKey });
      }
    }
  }

  private markApplied(id: string): void {
    this.applied.add(id);
    if (this.applied.size > MAX_APPLIED_IDS) {
      const oldest = this.applied.values().next().value;
      if (oldest !== undefined) this.applied.delete(oldest);
    }
  }

  private setCursor(stream: string, seq: number): void {
    this.cursors.set(stream, seq);
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.cursors)));
    } catch {
      // Private mode or quota: memory still works for this page.
    }
  }
}

function defaultSocket(namespace: Namespace): RealtimeSocket {
  return io(namespace, { path: REALTIME_PATH, withCredentials: true });
}
