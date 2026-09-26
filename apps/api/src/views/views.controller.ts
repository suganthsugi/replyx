import { Controller, Get, Param, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { ViewsService, type ViewDto } from './views.service.js';

import type { Request } from 'express';

/** `/views`, `/views/{id}` (contracts/tickets.yaml; POST/PUT/DELETE and `/views/order` are a follow-up). */

const IdParams = z.object({ id: z.uuid() }).strict();

@Controller('views')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @RequirePermission('view.view')
  async list(@Req() req: Request): Promise<{ items: ViewDto[] }> {
    const items = await this.views.list(tenantContextOf(req));
    return { items };
  }

  @Get(':id')
  @RequirePermission('view.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<ViewDto> {
    return this.views.get(tenantContextOf(req), params.id);
  }
}
