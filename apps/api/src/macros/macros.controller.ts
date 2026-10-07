import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MacroIdParams, MacroInputSchema, type MacroInput } from './macro-input.js';
import { MacrosService, type MacroDto } from './macros.service.js';

import type { Request } from 'express';
import type { z } from 'zod';

/**
 * `/macros`, `/macros/{id}` (contracts/tickets.yaml). Reading needs `macro.view`, writing needs
 * `macro.create` / `.edit` / `.delete`; the service limits every call to the macros the caller can
 * see (an invisible macro is 404).
 */
@Controller('macros')
export class MacrosController {
  constructor(private readonly macros: MacrosService) {}

  @Get()
  @RequirePermission('macro.view')
  async list(@Req() req: Request): Promise<{ items: MacroDto[] }> {
    return { items: await this.macros.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('macro.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(MacroInputSchema)) body: MacroInput): Promise<MacroDto> {
    return this.macros.create(tenantContextOf(req), body);
  }

  @Put(':id')
  @RequirePermission('macro.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(MacroIdParams)) params: z.infer<typeof MacroIdParams>,
    @Body(new ZodValidationPipe(MacroInputSchema)) body: MacroInput,
  ): Promise<MacroDto> {
    return this.macros.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('macro.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(MacroIdParams)) params: z.infer<typeof MacroIdParams>): Promise<void> {
    await this.macros.delete(tenantContextOf(req), params.id);
  }
}
