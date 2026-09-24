/**
 * Domain event types (research D7, contracts/realtime-events.md). Names are
 * `<resource>.<past_tense_verb>` in snake_case and are declared here once, with their payload.
 * Modules add their events to `DomainEventMap` when they are built; reuse a name before
 * inventing one.
 *
 * `payload` is what staff streams and consumers see. Events on a `conversation:*` stream also
 * carry a `customerPayload` built by the messaging projector (research D9).
 */

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
}

export type DomainEventType = keyof DomainEventMap;

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
