import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { CustomersService } from './customers.service.js';

import type { CustomerHistoryMessageDto, CustomerProfileDto } from './customer-dto.js';
import type { Request } from 'express';

/** Customer profiles (contracts/tickets.yaml `/customers/{id}`, `/customers/{id}/messages`). */

const IdParams = z.object({ id: z.uuid() }).strict();

const HistoryQuery = z.object({ ...paginationQuery }).strict();

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    company: z.string().trim().max(120).optional(),
    tagIds: z.array(z.uuid()).optional(),
  })
  .strict();

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get(':id')
  @RequirePermission('user.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<CustomerProfileDto> {
    return this.customers.get(tenantContextOf(req), params.id);
  }

  @Get(':id/messages')
  @RequirePermission('user.view')
  history(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Query(new ZodValidationPipe(HistoryQuery)) query: z.infer<typeof HistoryQuery>,
  ): Promise<Page<CustomerHistoryMessageDto>> {
    return this.customers.history(tenantContextOf(req), params.id, query);
  }

  @Patch(':id')
  @RequirePermission('user.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<CustomerProfileDto> {
    return this.customers.update(tenantContextOf(req), params.id, body);
  }
}
