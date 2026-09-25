/**
 * Domain event types (research D7, contracts/realtime-events.md). Names are
 * `<resource>.<past_tense_verb>` in snake_case and are declared here once, with their payload.
 * Modules add their events to `DomainEventMap` when they are built; reuse a name before
 * inventing one.
 *
 * `payload` is what staff streams and consumers see. Events on a `conversation:*` stream also
 * carry a `customerPayload` built by the messaging projector (research D9): the customer event
 * type (`conversation.*`) and its data, since one domain event can mean different things to a
 * customer (a state change can be `conversation.status` or `conversation.resolved`).
 */

import type { JsonValue } from '../db/tables/column-types.js';

/** Who caused the event. Matches `TenantContext['actor']`; `name` is filled in for display. */
export type EventActor =
  | { kind: 'user'; id: string; name?: string }
  | { kind: 'operator'; id: string; name?: string }
  | { kind: 'automation'; id: string; name?: string }
  | { kind: 'system' };

/** Automation loop guard (data-model.md "automation_rules"). */
export interface EventCause {
  ruleId?: string;
  depth?: number;
  eventId?: string;
}

export interface DomainEventMap {
  /** Sessions deleted by sign-out-all, deactivation or suspension; sockets disconnect. */
  'session.revoked': {
    userId: string;
    sessionIds: string[];
    reason: 'sign_out' | 'sign_out_all' | 'deactivated' | 'deleted' | 'tenant_suspended';
  };
  /** Roles, role permissions, group access, user roles or user status changed (research D6). */
  'access.changed': { accessVersion: string; reason: string };
  /** Sent to a user's stream after their rooms were recomputed (FR-025). */
  'access.revoked': { ticketIds?: string[]; groupIds?: (string | null)[] };
  /** The tenant was suspended; every socket of the tenant disconnects. */
  'tenant.suspended': Record<string, never>;
  /** Deactivated by an admin (FR-008): tickets consumers unassign the user's open tickets. */
  'user.deactivated': { userId: string };
  /** An admin asked for the user's data to be erased; the erasure job does it (T062). */
  'user.erasure_requested': { userId: string };
}

export type DomainEventType = keyof DomainEventMap;

/** What customer sockets receive for an event (contracts/realtime-events.md "Customer events"). */
export interface CustomerProjection {
  type: `conversation.${string}`;
  data: JsonValue;
}

export function isCustomerProjection(value: unknown): value is CustomerProjection {
  if (typeof value !== 'object' || value === null) return false;
  const { type, data } = value as { type?: unknown; data?: unknown };
  return typeof type === 'string' && type.startsWith('conversation.') && data !== undefined;
}

/**
 * Events the gateways act on besides delivering them (T037/T039): the relay also broadcasts
 * them to every api process with `serverSideEmit`.
 */
export const CONTROL_EVENT_TYPES: ReadonlySet<DomainEventType> = new Set([
  'session.revoked',
  'tenant.suspended',
  'access.changed',
]);

export type DomainEventPayload<T extends DomainEventType> = DomainEventMap[T];

/**
 * Stream keys are tenant-less; the relay and gateway add `t:{tenantId}:`
 * (realtime-events skill rule 4).
 */
export type StreamKey =
  | `user:${string}`
  | `views:${string}`
  | `ticket:${string}`
  | `tickets:group:${string}`
  | `conversation:${string}`
  /** Tenant-wide control stream: `access.changed`, `tenant.suspended` (gateway only). */
  | 'tenant';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STREAM_PATTERN = new RegExp(
  `^(?:(?:user|views|ticket|conversation):${UUID}|tickets:group:(?:${UUID}|ungrouped)|tenant)$`,
);

export function isStreamKey(value: string): value is StreamKey {
  return STREAM_PATTERN.test(value);
}

export function isCustomerStream(stream: StreamKey): boolean {
  return stream.startsWith('conversation:');
}

/**
 * The stream name clients see in the envelope and send back in `sync` (contract "Streams"):
 * a socket only ever sees its own `user`, `views` and `conversation` streams, so those drop the
 * id; `tickets:group:*` rooms are all the `tickets` stream; `ticket:{id}` is kept.
 */
export function clientStream(stream: StreamKey): string {
  if (stream.startsWith('user:')) return 'user';
  if (stream.startsWith('views:')) return 'views';
  if (stream.startsWith('conversation:')) return 'conversation';
  if (stream.startsWith('tickets:group:')) return 'tickets';
  return stream;
}
