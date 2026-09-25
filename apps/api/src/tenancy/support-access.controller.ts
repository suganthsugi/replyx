import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MAX_GRANT_HOURS, MIN_GRANT_HOURS, SupportAccessService, type SupportGrantDto } from './support-access.service.js';

import type { Request } from 'express';

/**
 * The tenant admin's side of support access (contracts/operations.yaml `/support-access*`,
 * FR-001a): who may look, for how long, and the button that ends it early.
 */

const CreateBody = z
  .object({
    durationHours: z.int().min(MIN_GRANT_HOURS).max(MAX_GRANT_HOURS),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const IdParams = z.object({ id: z.uuid() }).strict();

@Controller('support-access')
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Get()
  @RequirePermission('support_access.view')
  list(@Req() req: Request): Promise<SupportGrantDto[]> {
    return this.supportAccess.list(tenantContextOf(req));
  }

  @Post()
  @RequirePermission('support_access.create')
  create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<SupportGrantDto> {
    return this.supportAccess.create(tenantContextOf(req), body);
  }

  @Post(':id/revoke')
  @RequirePermission('support_access.delete')
  @HttpCode(200)
  revoke(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
  ): Promise<SupportGrantDto> {
    return this.supportAccess.revoke(tenantContextOf(req), params.id);
  }
}
