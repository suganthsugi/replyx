import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';

import { RequirePermission } from '../../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import {
  IdParamsSchema,
  PolicyDocumentInputSchema,
  PolicyRenameSchema,
  PolicyVersionInputSchema,
  type PolicyDocumentInput,
  type PolicyRename,
  type PolicyVersionInput,
} from './ai-policies.input.js';
import { AiPoliciesService, type PolicyDocumentDetailDto, type PolicyDocumentDto, type PolicyVersionDto } from './ai-policies.service.js';

import type { Request } from 'express';
import type { z } from 'zod';

type IdParams = z.infer<typeof IdParamsSchema>;

/** `/ai/policies*` (contracts/ai.yaml), all behind `ai_knowledge.manage`. */
@Controller('ai/policies')
export class AiPoliciesController {
  constructor(private readonly policies: AiPoliciesService) {}

  @Get()
  @RequirePermission('ai_knowledge.manage')
  async list(@Req() req: Request): Promise<{ items: PolicyDocumentDto[] }> {
    return { items: await this.policies.list(tenantContextOf(req)) };
  }

  @Post()
  @RequirePermission('ai_knowledge.manage')
  create(@Req() req: Request, @Body(new ZodValidationPipe(PolicyDocumentInputSchema)) body: PolicyDocumentInput): Promise<PolicyDocumentDto> {
    return this.policies.create(tenantContextOf(req), body);
  }

  @Get(':id')
  @RequirePermission('ai_knowledge.manage')
  get(@Req() req: Request, @Param(new ZodValidationPipe(IdParamsSchema)) params: IdParams): Promise<PolicyDocumentDetailDto> {
    return this.policies.get(tenantContextOf(req), params.id);
  }

  @Patch(':id')
  @RequirePermission('ai_knowledge.manage')
  rename(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParamsSchema)) params: IdParams,
    @Body(new ZodValidationPipe(PolicyRenameSchema)) body: PolicyRename,
  ): Promise<PolicyDocumentDto> {
    return this.policies.rename(tenantContextOf(req), params.id, body.title);
  }

  @Delete(':id')
  @RequirePermission('ai_knowledge.manage')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param(new ZodValidationPipe(IdParamsSchema)) params: IdParams): Promise<void> {
    await this.policies.remove(tenantContextOf(req), params.id);
  }

  @Post(':id/versions')
  @RequirePermission('ai_knowledge.manage')
  createVersion(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParamsSchema)) params: IdParams,
    @Body(new ZodValidationPipe(PolicyVersionInputSchema)) body: PolicyVersionInput,
  ): Promise<PolicyVersionDto> {
    return this.policies.createVersion(tenantContextOf(req), params.id, body);
  }
}
