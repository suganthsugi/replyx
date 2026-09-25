import { Controller, Get, Module, Req } from '@nestjs/common';

import { tenantContextOf } from '../platform-kernel/http/request-context.js';

import { RequirePermission } from './registry/module-permissions.js';
import { RolesService, type RoleDto } from './roles.service.js';

import type { Request } from 'express';

/** Roles API (contracts/access.yaml). `GET /roles` only until US4 (T091). */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('role.view')
  async list(@Req() req: Request): Promise<{ items: RoleDto[] }> {
    return { items: await this.roles.list(tenantContextOf(req)) };
  }
}

/** HTTP side of roles (api process only). */
@Module({ controllers: [RolesController], providers: [RolesService] })
export class RolesHttpModule {}
