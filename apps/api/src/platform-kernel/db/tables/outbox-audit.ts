import type { ColumnType, Generated, GeneratedTimestamp, JsonValue } from './column-types.js';

/**
 * Migration 0005_outbox_audit. Tenant-scoped for the app role (append, replay); the relay reads
 * all tenants through the platform pool.
 */
export interface OutboxEventsTable {
  id: string;
  tenant_id: string;
  type: string;
  actor: JsonValue;
  payload: JsonValue;
  customer_payload: JsonValue | null;
  streams: string[];
  cause: JsonValue | null;
  created_at: GeneratedTimestamp;
  /** bigint, assigned by the relay: pg returns it as a string. */
  seq: ColumnType<string | null, never, string | number>;
  published_at: ColumnType<Date | null, never, Date | string>;
}

export interface ProcessedEventsTable {
  consumer: string;
  event_id: string;
  processed_at: GeneratedTimestamp;
}

export type AuditActorKind = 'user' | 'operator' | 'system' | 'automation';

export interface AuditLogsTable {
  id: Generated<string>;
  tenant_id: string;
  occurred_at: GeneratedTimestamp;
  actor_id: string | null;
  actor_kind: AuditActorKind;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Generated<JsonValue>;
  ip: string | null;
  request_id: string | null;
}

export interface OutboxAuditTables {
  outbox_events: OutboxEventsTable;
  processed_events: ProcessedEventsTable;
  audit_logs: AuditLogsTable;
}
