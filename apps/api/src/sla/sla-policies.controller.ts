import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { IdParams } from './business-hours-input.js';
import { SlaPoliciesService, type SlaPolicyDto } from './sla-policies.service.js';
import { SlaPolicyInputSchema, type SlaPolicyInput } from './sla-policy-input.js';

import type { Request } from 'express';
import type { z } from 'zod';

/**
 * `/sla-policies*` (contracts/operations.yaml): `sla_policy.view`, `.create`, `.edit`, `.delete`.
 * Changing a policy recomputes the SLA times of open tickets.
 */
@Controller('sla-policies')
export class SlaPoliciesController {
  constructor(private readonly policies: SlaPoliciesService) {}

  @Get()
  @RequirePermission('sla_policy.view')
  async list(@Req() req: Request): Promise<{ items: SlaPolicyDto[] }> {
    return { items: await this.policies.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('sla_policy.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(SlaPolicyInputSchema)) body: SlaPolicyInput): Promise<SlaPolicyDto> {
    return this.policies.create(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('sla_policy.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(SlaPolicyInputSchema)) body: SlaPolicyInput,
  ): Promise<SlaPolicyDto> {
    return this.policies.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('sla_policy.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.policies.delete(tenantContextOf(req), params.id);
  }
}
