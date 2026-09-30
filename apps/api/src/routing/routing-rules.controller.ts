import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import {
  RoutingRuleIdParams,
  RoutingRuleInputSchema,
  RoutingRuleOrderSchema,
  RoutingRuleTestSchema,
  type RoutingRuleInput,
  type RoutingRuleTestInput,
} from './routing-rule-input.js';
import { RoutingRulesService, type RoutingDryRunDto, type RoutingRuleDto } from './routing-rules.service.js';

import type { Request } from 'express';
import type { z } from 'zod';

/**
 * `/routing-rules*` (contracts/operations.yaml). Read and dry-run need `routing_rule.view`;
 * create, reorder/replace and delete need `routing_rule.create`, `.edit`, `.delete`. Static
 * segments (`order`, `test`) are declared before `:id`.
 */
@Controller('routing-rules')
export class RoutingRulesController {
  constructor(private readonly rules: RoutingRulesService) {}

  @Get()
  @RequirePermission('routing_rule.view')
  async list(@Req() req: Request): Promise<{ items: RoutingRuleDto[] }> {
    return { items: await this.rules.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('routing_rule.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(RoutingRuleInputSchema)) body: RoutingRuleInput): Promise<RoutingRuleDto> {
    return this.rules.create(tenantContextOf(req), body);
  }

  @Put('order')
  @RequirePermission('routing_rule.edit')
  @HttpCode(204)
  async order(@Req() req: Request, @Body(new ZodValidationPipe(RoutingRuleOrderSchema)) body: z.infer<typeof RoutingRuleOrderSchema>): Promise<void> {
    await this.rules.reorder(tenantContextOf(req), body.ids);
  }

  /** Read-only: a POST because the sample message is a body, not a resource. */
  @Post('test')
  @RequirePermission('routing_rule.view')
  @HttpCode(200)
  test(@Req() req: Request, @Body(new ZodValidationPipe(RoutingRuleTestSchema)) body: RoutingRuleTestInput): Promise<RoutingDryRunDto> {
    return this.rules.dryRun(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('routing_rule.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(RoutingRuleIdParams)) params: z.infer<typeof RoutingRuleIdParams>,
    @Body(new ZodValidationPipe(RoutingRuleInputSchema)) body: RoutingRuleInput,
  ): Promise<RoutingRuleDto> {
    return this.rules.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('routing_rule.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(RoutingRuleIdParams)) params: z.infer<typeof RoutingRuleIdParams>): Promise<void> {
    await this.rules.delete(tenantContextOf(req), params.id);
  }
}
