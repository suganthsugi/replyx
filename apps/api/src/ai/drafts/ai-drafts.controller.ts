import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { AiDraftsService, type AiDraftDto } from './ai-drafts.service.js';

import type { Request } from 'express';

const IdParams = z.object({ id: z.uuid() }).strict();

/** `/tickets/{id}/ai-draft` (contracts/ai.yaml): the open AI draft for the composer. */
@Controller('tickets')
export class AiDraftsController {
  constructor(private readonly drafts: AiDraftsService) {}

  @Get(':id/ai-draft')
  @RequirePermission('ticket.edit')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<AiDraftDto> {
    return this.drafts.get(tenantContextOf(req), params.id);
  }

  @Post(':id/ai-draft/discard')
  @HttpCode(204)
  @RequirePermission('ticket.edit')
  async discard(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.drafts.discard(tenantContextOf(req), params.id);
  }
}
