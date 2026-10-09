import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { RateLimit } from '../../platform-kernel/http/rate-limit.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { StoreConnectionInputSchema, type StoreConnectionInput } from './store-connection.input.js';
import { StoreConnectionService, type StoreConnectionDto, type StoreTestDto } from './store-connection.service.js';

import type { Request } from 'express';

/** `/ai/store-connection*` (contracts/ai.yaml), all behind `ai_settings.manage`. */
@Controller('ai/store-connection')
export class StoreConnectionController {
  constructor(private readonly connection: StoreConnectionService) {}

  @Get()
  @RequirePermission('ai_settings.manage')
  get(@Req() req: Request): Promise<StoreConnectionDto> {
    return this.connection.get(tenantContextOf(req));
  }

  @Put()
  @RequirePermission('ai_settings.manage')
  put(@Req() req: Request, @Body(new ZodValidationPipe(StoreConnectionInputSchema)) body: StoreConnectionInput): Promise<StoreConnectionDto> {
    return this.connection.put(tenantContextOf(req), body);
  }

  @Delete()
  @RequirePermission('ai_settings.manage')
  @HttpCode(204)
  async remove(@Req() req: Request): Promise<void> {
    await this.connection.remove(tenantContextOf(req));
  }

  @Post('test')
  @RequirePermission('ai_settings.manage')
  @RateLimit('ai-store-test')
  @HttpCode(200)
  test(@Req() req: Request): Promise<StoreTestDto> {
    return this.connection.test(tenantContextOf(req));
  }
}
