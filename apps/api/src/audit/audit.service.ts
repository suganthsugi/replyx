import { Injectable, Logger } from '@nestjs/common';

import { TenantRepository, type TenantInsert } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { Actor } from '../platform-kernel/db/tenant-context.js';

/**
 * The append-only audit log (FR-092, data-model.md "audit_logs"). Entries are written in the
 * caller's transaction, so a rolled-back change leaves no audit entry. Actor, request id and IP
 * come from the transaction's `TenantContext` unless the caller passes the actor of an event
 * (the audit consumer). The app role cannot update or delete entries.
 *
 * `details` never contains message bodies or secrets: keys that could hold them are dropped
 * (and logged) before the insert, at any depth.
 */

export interface AuditEntry {
  /** `<resource>.<verb>`, e.g. `ticket.assigned`, `auth.locked`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, JsonValue>;
}

const FORBIDDEN_KEY =
  /^(body|bodies|text|html|content|message|messages|note|password|new_?password|current_?password|password_?hash|token|tokens|token_?hash|secret|secrets|cookie|cookies|authorization|api_?key|link|url_?token)$/i;
const MAX_DETAILS_BYTES = 8_192;

/** `details` without keys that may carry message bodies or secrets, and the keys it dropped. */
export function sanitizeDetails(details: Record<string, JsonValue>): { details: Record<string, JsonValue>; dropped: string[] } {
  const dropped: string[] = [];
  const clean = (value: JsonValue, path: string): JsonValue => {
    if (Array.isArray(value)) return value.map((item, index) => clean(item, `${path}.${index}`));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, JsonValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      const child = path === '' ? key : `${path}.${key}`;
      if (FORBIDDEN_KEY.test(key)) {
        dropped.push(child);
        continue;
      }
      out[key] = clean(inner, child);
    }
    return out;
  };
  const result = clean(details, '') as Record<string, JsonValue>;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DETAILS_BYTES) {
    return { details: { truncated: true }, dropped };
  }
  return { details: result, dropped };
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  async record(tx: TenantTransaction, entry: AuditEntry, options: { actor?: Actor } = {}): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('AuditService.record must run inside withTenant');
    const { details, dropped } = sanitizeDetails(entry.details ?? {});
    if (dropped.length > 0) {
      this.logger.warn(`Audit ${entry.action} dropped detail keys: ${dropped.join(', ')}`);
    }
    const actor = options.actor ?? ctx.actor;
    await new AuditRepository(ctx).insert(tx, {
      actor_kind: actor.kind,
      actor_id: actor.kind === 'system' ? null : actor.id,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      details: JSON.stringify(details),
      ip: ctx.ip,
      request_id: ctx.requestId,
    });
  }
}

class AuditRepository extends TenantRepository {
  async insert(tx: TenantTransaction, row: TenantInsert<'audit_logs'>): Promise<void> {
    await this.insertInto(tx, 'audit_logs', row).execute();
  }
}
