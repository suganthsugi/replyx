import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { AutomationRuleIdParams, AutomationRuleInputSchema, type AutomationRuleInput } from './automation-rule-input.js';
import { AutomationRulesService, type AutomationRuleDto } from './automation-rules.service.js';

import type { Request } from 'express';
import type { z } from 'zod';

/** `/automation-rules*` (contracts/operations.yaml, T255): `automation_rule.view` / `.create` / `.edit` / `.delete`. */
@Controller('automation-rules')
export class AutomationRulesController {
  constructor(private readonly rules: AutomationRulesService) {}

  @Get()
  @RequirePermission('automation_rule.view')
  async list(@Req() req: Request): Promise<{ items: AutomationRuleDto[] }> {
    return { items: await this.rules.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('automation_rule.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(AutomationRuleInputSchema)) body: AutomationRuleInput): Promise<AutomationRuleDto> {
    return this.rules.create(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('automation_rule.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(AutomationRuleIdParams)) params: z.infer<typeof AutomationRuleIdParams>,
    @Body(new ZodValidationPipe(AutomationRuleInputSchema)) body: AutomationRuleInput,
  ): Promise<AutomationRuleDto> {
    return this.rules.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('automation_rule.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(AutomationRuleIdParams)) params: z.infer<typeof AutomationRuleIdParams>): Promise<void> {
    await this.rules.delete(tenantContextOf(req), params.id);
  }
}
