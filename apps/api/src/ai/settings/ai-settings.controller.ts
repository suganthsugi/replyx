import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { RateLimit } from '../../platform-kernel/http/rate-limit.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { AiSettingsPatchSchema, ProviderKeyInputSchema, type AiSettingsPatch, type ProviderKeyInput } from './ai-settings.input.js';
import { AiSettingsService, modelCatalog, type AiModelsDto, type AiSettingsDto, type ConnectionTestDto } from './ai-settings.service.js';

import type { Request } from 'express';

/** `/ai/settings*` and `/ai/models` (contracts/ai.yaml), all behind `ai_settings.manage`. */
@Controller('ai')
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get('settings')
  @RequirePermission('ai_settings.manage')
  get(@Req() req: Request): Promise<AiSettingsDto> {
    return this.settings.get(tenantContextOf(req));
  }

  @Patch('settings')
  @RequirePermission('ai_settings.manage')
  update(@Req() req: Request, @Body(new ZodValidationPipe(AiSettingsPatchSchema)) body: AiSettingsPatch): Promise<AiSettingsDto> {
    return this.settings.update(tenantContextOf(req), body);
  }

  @Put('settings/provider-key')
  @RequirePermission('ai_settings.manage')
  setKey(@Req() req: Request, @Body(new ZodValidationPipe(ProviderKeyInputSchema)) body: ProviderKeyInput): Promise<AiSettingsDto> {
    return this.settings.setKey(tenantContextOf(req), body);
  }

  @Delete('settings/provider-key')
  @RequirePermission('ai_settings.manage')
  @HttpCode(204)
  async removeKey(@Req() req: Request): Promise<void> {
    await this.settings.removeKey(tenantContextOf(req));
  }

  @Post('settings/provider-key/test')
  @RequirePermission('ai_settings.manage')
  @RateLimit('ai-key-test')
  @HttpCode(200)
  testKey(@Req() req: Request): Promise<ConnectionTestDto> {
    return this.settings.testKey(tenantContextOf(req));
  }

  @Get('models')
  @RequirePermission('ai_settings.manage')
  models(): AiModelsDto {
    return modelCatalog();
  }
}
