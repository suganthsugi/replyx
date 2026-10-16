import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { DeliveriesQuery, WebhookIdParams, WebhookInputSchema, type WebhookInput } from './webhook-input.js';
import { WebhooksService, type WebhookDeliveryDto, type WebhookDto } from './webhooks.service.js';

import type { Page } from '../../platform-kernel/http/pagination.js';
import type { Request } from 'express';
import type { z } from 'zod';

/** `/webhooks*` (contracts/operations.yaml, T261): `webhook.view` / `.create` / `.edit` / `.delete`. */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission('webhook.view')
  async list(@Req() req: Request): Promise<{ items: WebhookDto[] }> {
    return { items: await this.webhooks.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('webhook.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(WebhookInputSchema)) body: WebhookInput): Promise<WebhookDto & { secret: string }> {
    return this.webhooks.create(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('webhook.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(WebhookIdParams)) params: z.infer<typeof WebhookIdParams>,
    @Body(new ZodValidationPipe(WebhookInputSchema)) body: WebhookInput,
  ): Promise<WebhookDto> {
    return this.webhooks.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('webhook.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(WebhookIdParams)) params: z.infer<typeof WebhookIdParams>): Promise<void> {
    await this.webhooks.delete(tenantContextOf(req), params.id);
  }

  @Post(':id/rotate-secret')
  @RequirePermission('webhook.edit')
  @HttpCode(200)
  rotateSecret(@Req() req: Request, @Param(new ZodValidationPipe(WebhookIdParams)) params: z.infer<typeof WebhookIdParams>): Promise<{ secret: string }> {
    return this.webhooks.rotateSecret(tenantContextOf(req), params.id);
  }

  @Get(':id/deliveries')
  @RequirePermission('webhook.view')
  deliveries(
    @Req() req: Request,
    @Param(new ZodValidationPipe(WebhookIdParams)) params: z.infer<typeof WebhookIdParams>,
    @Query(new ZodValidationPipe(DeliveriesQuery)) query: z.infer<typeof DeliveriesQuery>,
  ): Promise<Page<WebhookDeliveryDto>> {
    return this.webhooks.deliveries(tenantContextOf(req), params.id, query);
  }
}
