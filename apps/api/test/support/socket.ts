import { io, type Socket } from 'socket.io-client';

import { getTestApp } from './app.js';

import type { TestUser } from './factories.js';

/**
 * Authenticated socket.io-client connections to the app under test (path `/rt`). Each call
 * opens its own connection (`forceNew`): the client otherwise multiplexes namespaces over one
 * connection and reuses the first handshake's cookie.
 */

export interface ConnectOptions {
  /** Defaults to `/customer` for customers, `/` for staff. */
  namespace?: '/' | '/customer';
  /** Override the host header (cross-tenant checks). */
  host?: string;
  /** Send no session cookie. */
  anonymous?: boolean;
}

function open(user: TestUser, options: ConnectOptions, baseUrl: string): Socket {
  const namespace = options.namespace ?? (user.kind === 'customer' ? '/customer' : '/');
  const cookie = options.anonymous === true || user.sessionToken === undefined ? undefined : `rx_session=${user.sessionToken}`;
  return io(`${baseUrl}${namespace}`, {
    path: '/rt',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { host: options.host ?? user.tenant.host, ...(cookie === undefined ? {} : { cookie }) },
  });
}

/** A refused handshake; `code` is the server's `connect_error` code (e.g. `UNAUTHENTICATED`). */
export class SocketConnectError extends Error {
  constructor(readonly code: string) {
    super(`Socket connection refused: ${code}`);
  }
}

/** Resolves once connected; rejects with a `SocketConnectError`. */
export async function connectSocket(user: TestUser, options: ConnectOptions = {}): Promise<Socket> {
  const socket = open(user, options, (await getTestApp()).baseUrl);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error: Error & { data?: unknown }) => {
      socket.close();
      const code = (error.data as { code?: unknown } | undefined)?.code;
      reject(new SocketConnectError(typeof code === 'string' ? code : error.message));
    });
  });
}

/** The handshake error code, or `connected` (the socket is closed either way). */
export async function connectResult(user: TestUser, options: ConnectOptions = {}): Promise<string> {
  try {
    (await connectSocket(user, options)).close();
    return 'connected';
  } catch (error) {
    if (error instanceof SocketConnectError) return error.code;
    throw error;
  }
}

/** The next `event` matching `predicate`, or a rejection after `timeoutMs`. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for "${event}"`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}
