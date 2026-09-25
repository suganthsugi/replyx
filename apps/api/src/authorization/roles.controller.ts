import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';

import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { RequirePermission } from './registry/module-permissions.js';
import { RolesService, type PermissionDto, type RoleDto } from './roles.service.js';

import type { Request } from 'express';

/** Roles and permission registry API (contracts/access.yaml). */

const IdParams = z.object({ id: z.uuid() }).strict();

const GroupAccessEntry = z
  .object({
    groupId: z.uuid().nullable(),
    view: z.boolean(),
    create: z.boolean(),
    edit: z.boolean(),
    delete: z.boolean(),
  })
  .strict();

const RoleInputBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().max(300).optional(),
    permissions: z.array(z.string()),
    groupAccess: z.array(GroupAccessEntry),
  })
  .strict();

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('role.view')
  list(): { items: PermissionDto[] } {
    return { items: this.roles.permissions() };
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('role.view')
  async list(@Req() req: Request): Promise<{ items: RoleDto[] }> {
    return { items: await this.roles.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('role.create')
  create(@Req() req: Request, @Body(new ZodValidationPipe(RoleInputBody)) body: z.infer<typeof RoleInputBody>): Promise<RoleDto> {
    return this.roles.create(tenantContextOf(req), body);
  }

  @Get(':id')
  @RequirePermission('role.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<RoleDto> {
    return this.roles.get(tenantContextOf(req), params.id);
  }

  @Put(':id')
  @RequirePermission('role.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(RoleInputBody)) body: z.infer<typeof RoleInputBody>,
  ): Promise<RoleDto> {
    return this.roles.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('role.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.roles.delete(tenantContextOf(req), params.id);
  }
}

/** HTTP side of roles and permissions (api process only). */
@Module({ controllers: [PermissionsController, RolesController], providers: [RolesService] })
export class RolesHttpModule {}
