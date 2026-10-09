import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { AiTakeoverService } from './ai-takeover.service.js';

import type { Responder } from '../../platform-kernel/outbox/event-types.js';
import type { Request } from 'express';

const IdParams = z.object({ id: z.uuid() }).strict();

/** `/tickets/{id}/ai/takeover` and `/ai/handback` (contracts/ai.yaml, FR-030). */
@Controller('tickets')
export class AiTakeoverController {
  constructor(private readonly takeover: AiTakeoverService) {}

  @Post(':id/ai/takeover')
  @HttpCode(200)
  @RequirePermission('ticket.edit')
  takeOver(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<Responder> {
    return this.takeover.takeOver(tenantContextOf(req), params.id);
  }

  @Post(':id/ai/handback')
  @HttpCode(200)
  @RequirePermission('ticket.edit')
  handBack(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<Responder> {
    return this.takeover.handBack(tenantContextOf(req), params.id);
  }
}
