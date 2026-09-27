import { Body, Controller, Delete, Get, HttpCode, Param, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { ViewCountsService, type ViewCounts } from './view-counts.service.js';
import { ViewsService, type ViewDto } from './views.service.js';

import type { Request } from 'express';

/**
 * `/views`, `/views/counts`, `/views/order`, `/views/{id}` (contracts/tickets.yaml; POST/PUT of a
 * view are US10). Reading needs `view.view`; the service decides arranging and deleting per view
 * (a personal view is its owner's, a shared one needs `view.edit` / `view.delete`).
 */

const IdParams = z.object({ id: z.uuid() }).strict();

const OrderBody = z
  .object({
    items: z
      .array(z.object({ id: z.uuid(), position: z.number().int().min(0).max(10_000), hidden: z.boolean() }).strict())
      .min(1)
      .max(200)
      // An id listed twice would be ambiguous: reported as `invalid` on `items`.
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  })
  .strict();

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

  @Put('order')
  @RequirePermission('view.view')
  @HttpCode(204)
  async order(@Req() req: Request, @Body(new ZodValidationPipe(OrderBody)) body: z.infer<typeof OrderBody>): Promise<void> {
    await this.views.reorder(tenantContextOf(req), body.items);
  }

  @Get(':id')
  @RequirePermission('view.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<ViewDto> {
    return this.views.get(tenantContextOf(req), params.id);
  }

  @Delete(':id')
  @RequirePermission('view.view')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.views.delete(tenantContextOf(req), params.id);
  }
}
