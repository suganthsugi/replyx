import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { BusinessHoursInputSchema, IdParams, type BusinessHoursInput } from './business-hours-input.js';
import { BusinessHoursService, type BusinessHoursDto } from './business-hours.service.js';

import type { Request } from 'express';
import type { z } from 'zod';

/**
 * `/business-hours*` (contracts/operations.yaml). Business-hours calendars share the `sla_policy`
 * permissions: `.view` to read, `.create`, `.edit` (replace; open tickets' SLA times are recomputed)
 * and `.delete` (409 `IN_USE` while a policy or the workspace settings use the calendar).
 */
@Controller('business-hours')
export class BusinessHoursController {
  constructor(private readonly calendars: BusinessHoursService) {}

  @Get()
  @RequirePermission('sla_policy.view')
  async list(@Req() req: Request): Promise<{ items: BusinessHoursDto[] }> {
    return { items: await this.calendars.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('sla_policy.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(BusinessHoursInputSchema)) body: BusinessHoursInput): Promise<BusinessHoursDto> {
    return this.calendars.create(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('sla_policy.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(BusinessHoursInputSchema)) body: BusinessHoursInput,
  ): Promise<BusinessHoursDto> {
    return this.calendars.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('sla_policy.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.calendars.delete(tenantContextOf(req), params.id);
  }
}
