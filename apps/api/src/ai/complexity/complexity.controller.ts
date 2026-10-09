import { Body, Controller, Get, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { ComplexityConfigSchema, type ComplexityConfigInput } from './complexity.input.js';
import { ComplexityService } from './complexity.service.js';

import type { ComplexityConfig } from './complexity-scorer.js';
import type { Request } from 'express';

/** `/ai/complexity` (contracts/ai.yaml), behind `ai_settings.manage`. */
@Controller('ai/complexity')
export class ComplexityController {
  constructor(private readonly complexity: ComplexityService) {}

  @Get()
  @RequirePermission('ai_settings.manage')
  get(@Req() req: Request): Promise<ComplexityConfig> {
    return this.complexity.get(tenantContextOf(req));
  }

  @Put()
  @RequirePermission('ai_settings.manage')
  put(@Req() req: Request, @Body(new ZodValidationPipe(ComplexityConfigSchema)) body: ComplexityConfigInput): Promise<ComplexityConfig> {
    return this.complexity.put(tenantContextOf(req), body);
  }
}
