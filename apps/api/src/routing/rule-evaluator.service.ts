import { Injectable } from '@nestjs/common';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { TagsService } from '../tags/tags.service.js';

import { evaluateRules, type GroupStatus, type RoutingEvaluation, type RoutingRuleRecord, type RoutingSubject } from './rule-evaluation.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Loads what `evaluateRules` needs inside the caller's transaction and runs it. The rule-based
 * router (real tickets) and the dry-run endpoint (T216) both go through `evaluate`, so a test of
 * a rule set answers exactly what routing would do. Read-only: it never writes.
 *
 * The matched rule's `tagIds` only contain tags that still exist in the tenant (a deleted tag
 * leaves a dangling id in the rule's jsonb, since there is no foreign key from jsonb).
 */
@Injectable()
export class RoutingEvaluator {
  constructor(private readonly tags: TagsService) {}

  /** The customer attributes rules look at: their tags come from `customer_tags`. */
  async subjectFor(tx: TenantTransaction, customer: { id: string; email: string }, messageBody: string): Promise<RoutingSubject> {
    const tags = (await this.tags.tagsByUserIds(tx, [customer.id])).get(customer.id) ?? [];
    return { messageBody, customerEmail: customer.email, customerTagIds: tags.map((tag) => tag.id) };
  }

  async evaluate(tx: TenantTransaction, subject: RoutingSubject): Promise<RoutingEvaluation> {
    const repo = new RoutingRulesRepository(requireScope(tx));
    const rules = await repo.enabledRules(tx);
    if (rules.length === 0) return { matched: null, skipped: [] };

    const groups = await repo.groupStatuses(tx, [...new Set(rules.map((rule) => rule.actions.groupId))]);
    const evaluation = evaluateRules(rules, subject, groups);
    if (evaluation.matched === null || evaluation.matched.tagIds.length === 0) return evaluation;

    const existing = await repo.existingTagIds(tx, evaluation.matched.tagIds);
    return { ...evaluation, matched: { ...evaluation.matched, tagIds: evaluation.matched.tagIds.filter((id) => existing.has(id)) } };
  }
}

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('RoutingEvaluator must run inside withTenant/withTenantReadOnly');
  return ctx;
}

export class RoutingRulesRepository extends TenantRepository {
  async enabledRules(tx: TenantTransaction): Promise<RoutingRuleRecord[]> {
    const rows = await this.selectFrom(tx, 'routing_rules')
      .select(['id', 'name', 'position', 'enabled', 'conditions', 'actions'])
      .where('enabled', '=', true)
      .orderBy('position')
      .orderBy('id')
      .execute();
    return rows;
  }

  async groupStatuses(tx: TenantTransaction, groupIds: readonly string[]): Promise<Map<string, GroupStatus>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'groups').select(['groups.id', 'groups.status']).where('groups.id', 'in', groupIds as string[]).execute();
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  async existingTagIds(tx: TenantTransaction, tagIds: readonly string[]): Promise<Set<string>> {
    if (tagIds.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'tags').select('tags.id').where('tags.id', 'in', tagIds as string[]).execute();
    return new Set(rows.map((row) => row.id));
  }
}
