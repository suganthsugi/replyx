import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { AuditLogsService, type AuditLogDto } from './audit-logs.service.js';

import type { Request } from 'express';

/**
 * `/audit-logs` (contracts/operations.yaml, T192): the append-only log, newest first, for users
 * with `audit_log.view`. Read-only; entries are written by services and the audit consumer.
 */

const ListQuery = z
  .object({
    ...paginationQuery,
    actorId: z.uuid().optional(),
    action: z.string().min(1).max(100).optional(),
    resourceType: z.string().min(1).max(64).optional(),
    resourceId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @RequirePermission('audit_log.view')
  list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<Page<AuditLogDto>> {
    return this.auditLogs.list(tenantContextOf(req), query);
  }
}
