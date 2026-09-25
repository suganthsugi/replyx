import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { UsersService, type UserDto } from './users.service.js';

import type { Request } from 'express';

/** User administration (contracts/identity.yaml `/users*`). */

const Email = z.email().max(254).transform((email) => email.toLowerCase());
const RoleIds = z.array(z.uuid()).min(1).max(50);

const ListQuery = z
  .object({
    ...paginationQuery,
    kind: z.enum(['staff', 'customer']).optional(),
    status: z.enum(['invited', 'active', 'deactivated']).optional(),
    roleId: z.uuid().optional(),
    q: z.string().max(100).optional(),
  })
  .strict();

const IdParams = z.object({ id: z.uuid() }).strict();

const InviteBody = z
  .object({ email: Email, name: z.string().trim().min(1).max(120).optional(), roleIds: RoleIds })
  .strict();

const UpdateBody = z.object({ name: z.string().trim().min(1).max(120).optional(), roleIds: RoleIds.optional() }).strict();

const EraseBody = z.object({ confirm: z.literal('ERASE') }).strict();

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.view')
  list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<Page<UserDto>> {
    return this.users.list(tenantContextOf(req), query);
  }

  @Post()
  @RequirePermission('user.create')
  invite(@Req() req: Request, @Body(new ZodValidationPipe(InviteBody)) body: z.infer<typeof InviteBody>): Promise<UserDto> {
    return this.users.invite(tenantContextOf(req), body);
  }

  @Get(':id')
  @RequirePermission('user.view')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<UserDto> {
    return this.users.get(tenantContextOf(req), params.id);
  }

  @Patch(':id')
  @RequirePermission('user.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<UserDto> {
    return this.users.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('user.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.users.delete(tenantContextOf(req), params.id);
  }

  @Post(':id/deactivate')
  @RequirePermission('user.edit')
  @HttpCode(200)
  deactivate(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<UserDto> {
    return this.users.deactivate(tenantContextOf(req), params.id);
  }

  @Post(':id/reactivate')
  @RequirePermission('user.edit')
  @HttpCode(200)
  reactivate(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<UserDto> {
    return this.users.reactivate(tenantContextOf(req), params.id);
  }

  @Post(':id/erase')
  @RequirePermission('user.erase')
  @HttpCode(202)
  async erase(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(EraseBody)) _body: z.infer<typeof EraseBody>,
  ): Promise<void> {
    await this.users.requestErasure(tenantContextOf(req), params.id);
  }
}
