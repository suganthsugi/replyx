import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { OperatorApi } from '../../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../../platform-kernel/http/pagination.js';
import { requestIdOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';
import { SuspensionService } from '../suspension.service.js';

import { TenantsService, type OperatorActor, type TenantDto } from './tenants.service.js';

import type { Request } from 'express';

/** Tenant administration for platform operators (contracts/platform.yaml `/tenants*`). */

/** The slug an operator may choose: 3–40 characters, no leading, trailing or doubled hyphen. */
const Slug = z.string().regex(/^[a-z0-9](-?[a-z0-9]){2,39}$/);

const ListQuery = z
  .object({
    ...paginationQuery,
    status: z.enum(['active', 'suspended']).optional(),
    q: z.string().max(100).optional(),
  })
  .strict();

const IdParams = z.object({ id: z.uuid() }).strict();

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: Slug,
    adminEmail: z.email().max(254).transform((email) => email.toLowerCase()),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

const UpdateBody = z.object({ name: z.string().trim().min(1).max(120).optional() }).strict();

const SuspendBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** Who is acting, for the tenant-side writes (the admin invitation) and their audit entries. */
export function operatorActorOf(req: Request): OperatorActor {
  if (req.operator === undefined) throw new Error('Operator routes need an authenticated operator');
  return { operatorId: req.operator.operatorId, requestId: requestIdOf(req), ip: req.ip ?? null };
}

@Controller('platform/tenants')
@OperatorApi()
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly suspension: SuspensionService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<Page<TenantDto>> {
    return this.tenants.list(query);
  }

  @Post()
  create(@Req() req: Request, @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<TenantDto> {
    return this.tenants.create(body, operatorActorOf(req));
  }

  @Get(':id')
  get(@Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<TenantDto> {
    return this.tenants.get(params.id);
  }

  @Patch(':id')
  update(
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<TenantDto> {
    return this.tenants.update(params.id, body);
  }

  /** Ends every session, blocks the tenant's routes and disconnects its sockets (FR-004). */
  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(SuspendBody)) body: z.infer<typeof SuspendBody>,
  ): Promise<TenantDto> {
    const actor = operatorActorOf(req);
    await this.tenants.requireTenant(params.id);
    await this.suspension.suspend(this.tenants.contextFor(params.id, actor), body.reason);
    return this.tenants.get(params.id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  async reactivate(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
  ): Promise<TenantDto> {
    const actor = operatorActorOf(req);
    await this.tenants.requireTenant(params.id);
    await this.suspension.reactivate(this.tenants.contextFor(params.id, actor));
    return this.tenants.get(params.id);
  }
}
