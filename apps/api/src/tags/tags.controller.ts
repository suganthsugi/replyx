import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { TagsService, type TagDto } from './tags.service.js';

import type { Request } from 'express';

/** Tags API (contracts/tickets.yaml `/tags*`). */

const IdParams = z.object({ id: z.uuid() }).strict();

const ListQuery = z.object({ q: z.string().max(60).optional() }).strict();

const Name = z.string().trim().min(1).max(40);

const CreateBody = z.object({ name: Name }).strict();

const UpdateBody = z.object({ name: Name }).strict();

@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @RequirePermission('tag.view')
  async list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<{ items: TagDto[] }> {
    return { items: await this.tags.list(tenantContextOf(req), query) };
  }

  @Post()
  @RequirePermission('tag.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<TagDto> {
    return this.tags.create(tenantContextOf(req), body);
  }

  @Patch(':id')
  @RequirePermission('tag.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<TagDto> {
    return this.tags.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('tag.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.tags.delete(tenantContextOf(req), params.id);
  }
}
