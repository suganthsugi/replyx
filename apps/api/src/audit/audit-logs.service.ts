import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';

import { AuditLogsRepository, type AuditLogRow } from './audit-logs.repository.js';

import type { JsonValue } from '../platform-kernel/db/tables/column-types.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/** `GET /audit-logs` (contracts/operations.yaml, FR-092): newest first, keyset-paginated. */

export interface AuditLogDto {
  id: string;
  occurredAt: string;
  actor: { kind: 'user' | 'operator' | 'system' | 'automation'; id: string | null; name?: string };
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, JsonValue>;
  ip: string | null;
}

export interface AuditLogListQuery {
  limit: number;
  cursor?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

// `occurredAt` is the microsecond ISO string the repository produced; anything else is a
// tampered cursor (and would be a cast error in the query).
const Position = z
  .object({ occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.uuid() })
  .strict();

function toAuditLogDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_name === null ? {} : { name: row.actor_name }),
    },
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    details: row.details as Record<string, JsonValue>,
    ip: row.ip,
  };
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  list(ctx: TenantContext, query: AuditLogListQuery): Promise<Page<AuditLogDto>> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Position);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rows = await new AuditLogsRepository(ctx).list(
        tx,
        {
          ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
          ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
          ...(query.from === undefined ? {} : { from: new Date(query.from) }),
          ...(query.to === undefined ? {} : { to: new Date(query.to) }),
          ...(after === undefined ? {} : { after }),
        },
        query.limit + 1,
      );
      return toPage(rows, query.limit, (row) => ({ occurredAt: row.occurred_at, id: row.id }), toAuditLogDto);
    });
  }
}
