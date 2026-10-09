import { Controller, Get, Query, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { AiRunsQuerySchema, type AiRunsQuery } from './ai-runs.input.js';
import { AiRunsService, type AiRunsPage } from './ai-runs.service.js';

import type { Request } from 'express';

/** `/ai/runs` (contracts/ai.yaml): AI usage and cost, behind `ai_usage.view`. */
@Controller('ai/runs')
export class AiRunsController {
  constructor(private readonly runs: AiRunsService) {}

  @Get()
  @RequirePermission('ai_usage.view')
  list(@Req() req: Request, @Query(new ZodValidationPipe(AiRunsQuerySchema)) query: AiRunsQuery): Promise<AiRunsPage> {
    return this.runs.list(tenantContextOf(req), query);
  }
}
