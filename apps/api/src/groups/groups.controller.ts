import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { GroupsService, type EligibleOwnerDto, type GroupDto } from './groups.service.js';

import type { Request } from 'express';

/** Groups API (contracts/access.yaml `/groups*`). */

const IdParams = z.object({ id: z.uuid() }).strict();

const ListQuery = z.object({ status: z.enum(['active', 'inactive']).optional() }).strict();

const Name = z.string().trim().min(1).max(80);
const Description = z.string().max(300);
const Status = z.enum(['active', 'inactive']);

const CreateBody = z.object({ name: Name, description: Description.optional(), status: Status.optional() }).strict();

const UpdateBody = z.object({ name: Name.optional(), description: Description.optional(), status: Status.optional() }).strict();

@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermission('group.view')
  async list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<{ items: GroupDto[] }> {
    return { items: await this.groups.list(tenantContextOf(req), query) };
  }

  @Post()
  @RequirePermission('group.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<GroupDto> {
    return this.groups.create(tenantContextOf(req), body);
  }

  @Get(':id')
  @RequirePermission('group.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<GroupDto> {
    return this.groups.get(tenantContextOf(req), params.id);
  }

  @Patch(':id')
  @RequirePermission('group.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<GroupDto> {
    return this.groups.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('group.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.groups.delete(tenantContextOf(req), params.id);
  }

  /** Owner picker: needs `ticket.edit` and edit on the group itself (checked in the service). */
  @Get(':id/eligible-owners')
  @RequirePermission('ticket.edit')
  async eligibleOwners(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
  ): Promise<{ items: EligibleOwnerDto[] }> {
    return { items: await this.groups.eligibleOwners(tenantContextOf(req), params.id) };
  }
}

/** HTTP side of groups (api process only). */
@Module({ controllers: [GroupsController], providers: [GroupsService] })
export class GroupsHttpModule {}
