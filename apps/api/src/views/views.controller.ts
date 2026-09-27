import { Controller, Get, Param, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { ViewCountsService, type ViewCounts } from './view-counts.service.js';
import { ViewsService, type ViewDto } from './views.service.js';

import type { Request } from 'express';

/** `/views`, `/views/counts`, `/views/{id}` (contracts/tickets.yaml; POST/PUT are US10). */

const IdParams = z.object({ id: z.uuid() }).strict();

@Controller('views')
export class ViewsController {
  constructor(
    private readonly views: ViewsService,
    private readonly viewCounts: ViewCountsService,
  ) {}

  @Get()
  @RequirePermission('view.view')
  async list(@Req() req: Request): Promise<{ items: ViewDto[] }> {
    const items = await this.views.list(tenantContextOf(req));
    return { items };
  }

  /** Declared before `:id`, which would otherwise take `counts` as an (invalid) id. */
  @Get('counts')
  @RequirePermission('view.view')
  counts(@Req() req: Request): Promise<ViewCounts> {
    return this.viewCounts.counts(tenantContextOf(req));
  }

  @Get(':id')
  @RequirePermission('view.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<ViewDto> {
    return this.views.get(tenantContextOf(req), params.id);
  }
}
