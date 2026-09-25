import { TenantContext } from '../db/tenant-context.js';
import { AppError } from '../http/app-error.js';
import { roomFor, type Envelope } from '../outbox/relay.js';

import type { SessionKind } from '../../identity/session.service.js';
import type { Socket } from 'socket.io';

/** Socket state, types and ack helpers shared by the gateway and its message handlers. */

export interface RealtimeSocketData {
  tenantId: string;
  userId: string;
  sessionId: string;
  kind: SessionKind;
  /** Session idle expiry (ms) as last checked; see session-expiry.ts. */
  expiresAt: number;
}

/** Server → client events (contracts/realtime-events.md). Ephemeral signals are added by T040. */
export interface ServerToClientEvents {
  event: (envelope: Envelope) => void;
  closing: (body: { code: string }) => void;
}

export type RealtimeSocket = Socket<Record<string, never>, ServerToClientEvents, Record<string, never>, RealtimeSocketData>;

export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

/** Emitted just before a server-initiated disconnect (Socket.IO has no custom disconnect reasons). */
export const CLOSING_EVENT = 'closing';

/**
 * Finds a ticket's group for `ticket:{id}` subscriptions: `null` = Ungrouped, `undefined` = no
 * such ticket in the context's tenant. Provided by the Tickets module (US6); until then every
 * ticket subscription is `NOT_FOUND`.
 */
export interface TicketGroupLookup {
  groupOf(ctx: TenantContext, ticketId: string): Promise<string | null | undefined>;
}
export const TICKET_GROUP_LOOKUP = Symbol('TICKET_GROUP_LOOKUP');

export function notFoundAck(): Ack {
  return { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } };
}

export function socketContext(socket: RealtimeSocket): TenantContext {
  return TenantContext.create({
    tenantId: socket.data.tenantId,
    actor: { kind: 'user', id: socket.data.userId },
    requestId: `socket:${socket.id}`.slice(0, 128),
  });
}

export const tenantRoom = (tenantId: string) => roomFor(tenantId, 'tenant');
export const sessionRoom = (tenantId: string, sessionId: string) => roomFor(tenantId, `session:${sessionId}`);

/** For ack errors from handlers that throw AppError (sync, typing, ...). */
export function errorAck(error: unknown): Ack {
  if (error instanceof AppError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } };
}
