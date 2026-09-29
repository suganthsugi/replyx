import { sql } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { AuditActorKind } from '../platform-kernel/db/tables/outbox-audit.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

export interface AuditLogRow {
  id: string;
  /** ISO 8601 UTC with microseconds, straight from Postgres so the cursor loses no precision. */
  occurred_at: string;
  actor_id: string | null;
  actor_kind: AuditActorKind;
  actor_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: JsonValue;
  ip: string | null;
}

export interface AuditLogFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  /** Keyset position of the last row of the previous page. */
  after?: { occurredAt: string; id: string };
}

/** Read side of `audit_logs` (the write side is `AuditService`). Every query is tenant-scoped. */
export class AuditLogsRepository extends TenantRepository {
  list(tx: TenantTransaction, filter: AuditLogFilter, limit: number): Promise<AuditLogRow[]> {
    let query = this.selectFrom(tx, 'audit_logs')
      .leftJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'audit_logs.tenant_id').onRef('users.id', '=', 'audit_logs.actor_id'),
      )
      .select([
        'audit_logs.id',
        'audit_logs.actor_id',
        'audit_logs.actor_kind',
        'users.name as actor_name',
        'audit_logs.action',
        'audit_logs.resource_type',
        'audit_logs.resource_id',
        'audit_logs.details',
        sql<string>`to_char(audit_logs.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('occurred_at'),
        sql<string | null>`host(audit_logs.ip)`.as('ip'),
      ]);

    if (filter.actorId !== undefined) query = query.where('audit_logs.actor_id', '=', filter.actorId);
    if (filter.action !== undefined) query = query.where('audit_logs.action', '=', filter.action);
    if (filter.resourceType !== undefined) query = query.where('audit_logs.resource_type', '=', filter.resourceType);
    if (filter.resourceId !== undefined) query = query.where('audit_logs.resource_id', '=', filter.resourceId);
    if (filter.from !== undefined) query = query.where('audit_logs.occurred_at', '>=', filter.from);
    if (filter.to !== undefined) query = query.where('audit_logs.occurred_at', '<=', filter.to);
    if (filter.after !== undefined) {
      query = query.where(
        sql<boolean>`(audit_logs.occurred_at, audit_logs.id) < (${filter.after.occurredAt}::timestamptz, ${filter.after.id}::uuid)`,
      );
    }
    return query.orderBy('audit_logs.occurred_at', 'desc').orderBy('audit_logs.id', 'desc').limit(limit).execute();
  }
}
