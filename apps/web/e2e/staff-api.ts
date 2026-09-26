import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

/**
 * A staff member acting through the API and a real-time socket from the test's Node side, for
 * specs where support has to answer a customer while the browser shows the customer's view.
 *
 * Node can't resolve `acme.localhost`, so this talks to the API service directly by compose name
 * and names the tenant in the Host header, exactly as the Vite proxy forwards it.
 */

const API_ORIGIN = process.env.E2E_API_URL ?? 'http://api:3000';
const TENANT_HOST = process.env.E2E_TENANT_HOST ?? 'acme.localhost:5173';

export interface StaffSession {
  api: APIRequestContext;
  socket: Socket;
  csrf: string;
  /** The session cookies as a `Cookie` header (sent explicitly: the request context stores them for
   * the API origin, not the tenant host the Host header names). */
  cookie: string;
  /** Resolves with the id of the next `ticket.created` whose title matches. */
  nextTicket(title: string): Promise<string>;
  close(): Promise<void>;
}

export async function signInStaff(email: string, password: string): Promise<StaffSession> {
  const api = await playwrightRequest.newContext({ baseURL: API_ORIGIN, extraHTTPHeaders: { Host: TENANT_HOST } });
  // Sign-ins are limited per IP (10 a minute) and every spec and project shares this one: wait
  // out a 429 rather than fail on the suite's own load.
  const deadline = Date.now() + 70_000;
  for (;;) {
    const response = await api.post('/api/v1/auth/sign-in', { data: { email, password } });
    if (response.ok()) break;
    const body = await response.text();
    if (response.status() !== 429 || Date.now() > deadline) throw new Error(`Staff sign-in failed: ${response.status()} ${body}`);
    const retryAfter = (JSON.parse(body) as { error?: { retryAfter?: number } }).error?.retryAfter ?? 5;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 250));
  }
  const { cookies } = await api.storageState();
  const csrf = cookies.find((cookie) => cookie.name === 'rx_csrf')?.value;
  if (csrf === undefined) throw new Error('Staff sign-in set no rx_csrf cookie');

  const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
  const socket = io(API_ORIGIN, {
    path: '/rt',
    transports: ['websocket'],
    extraHeaders: { Host: TENANT_HOST, Cookie: cookie },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
  });

  return {
    api,
    socket,
    csrf,
    cookie,
    nextTicket: (title) =>
      new Promise((resolve) => {
        const listener = (envelope: { type: string; data: { ticket?: { id: string; title: string } } }) => {
          if (envelope.type === 'ticket.created' && envelope.data.ticket?.title === title) {
            socket.off('event', listener);
            resolve(envelope.data.ticket.id);
          }
        };
        socket.on('event', listener);
      }),
    close: async () => {
      socket.disconnect();
      await api.dispose();
    },
  };
}

/** Staff typing on a ticket, which the ticket's customer sees as "{name} is typing". */
export async function staffTyping(session: StaffSession, ticketId: string, state: 'start' | 'stop'): Promise<void> {
  const ack = (await session.socket.timeout(5_000).emitWithAck('typing', { ticketId, state })) as { ok: boolean };
  if (!ack.ok) throw new Error(`typing was refused: ${JSON.stringify(ack)}`);
}

export async function staffReply(session: StaffSession, ticketId: string, body: string): Promise<void> {
  const response = await session.api.post(`/api/v1/tickets/${ticketId}/messages`, {
    headers: { 'X-CSRF-Token': session.csrf, Cookie: session.cookie },
    data: { body, visibility: 'public', clientMessageId: crypto.randomUUID() },
  });
  if (!response.ok()) throw new Error(`Staff reply failed: ${response.status()} ${await response.text()}`);
}
