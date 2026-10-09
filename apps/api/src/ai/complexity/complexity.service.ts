import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';
import { validationFailed, type ErrorDetail } from '../../platform-kernel/http/app-error.js';
import { AiSettingsRepository } from '../settings/ai-settings.repository.js';

import { ComplexityRepository } from './complexity.repository.js';

import type { ComplexityConfig } from './complexity-scorer.js';
import type { ComplexityConfigInput } from './complexity.input.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/**
 * `GET/PUT /ai/complexity` (specs/002-ai-assist FR-025, research R12): the factors and thresholds
 * that pick a turn's model level. A save replaces the whole set in one transaction, under the
 * `ai_settings` row lock. Besides the shape (complexity.input.ts) a save needs unique factor keys
 * (`duplicate`), at least one weight above 0 (`no_positive_weight` on `factors`), `standard`
 * below `advanced` (`not_above_standard` on `thresholds.advanced`) and existing tags
 * (`not_found` on `factors.i.tagId`). A tenant that never saved gets the defaults seeded when AI
 * is first switched on (`AiSettingsService`).
 */
@Injectable()
export class ComplexityService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  get(ctx: TenantContext): Promise<ComplexityConfig> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => new ComplexityRepository(ctx).config(tx));
  }

  async put(ctx: TenantContext, input: ComplexityConfigInput): Promise<ComplexityConfig> {
    const problems = shapeProblems(input);
    if (problems.length > 0) throw validationFailed(problems);

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new ComplexityRepository(ctx);
      const missingTags: ErrorDetail[] = [];
      for (const [index, factor] of input.factors.entries()) {
        if (factor.kind === 'customer_tag' && !(await repo.tagExists(tx, factor.tagId))) missingTags.push({ path: `factors.${index}.tagId`, issue: 'not_found' });
      }
      if (missingTags.length > 0) throw validationFailed(missingTags);

      await new AiSettingsRepository(ctx).lock(tx);
      await repo.replace(tx, input.factors);
      await repo.setThresholds(tx, input.thresholds);
      await this.audit.record(tx, {
        action: 'ai_complexity.updated',
        resourceType: 'ai_settings',
        details: { factors: input.factors.map((factor) => ({ key: factor.key, kind: factor.kind, weight: factor.weight })), thresholds: { ...input.thresholds } },
      });
      return repo.config(tx);
    });
  }
}

function shapeProblems(input: ComplexityConfigInput): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  const seen = new Set<string>();
  input.factors.forEach((factor, index) => {
    if (seen.has(factor.key)) problems.push({ path: `factors.${index}.key`, issue: 'duplicate' });
    seen.add(factor.key);
    if (factor.kind === 'choice') {
      const options = new Set<string>();
      factor.options.forEach((option, optionIndex) => {
        if (options.has(option.key)) problems.push({ path: `factors.${index}.options.${optionIndex}.key`, issue: 'duplicate' });
        options.add(option.key);
      });
    }
  });
  if (!input.factors.some((factor) => factor.weight > 0)) problems.push({ path: 'factors', issue: 'no_positive_weight' });
  if (input.thresholds.advanced <= input.thresholds.standard) problems.push({ path: 'thresholds.advanced', issue: 'not_above_standard' });
  return problems;
}
