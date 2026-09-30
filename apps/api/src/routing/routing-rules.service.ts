import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';

import { RoutingRuleWritesRepository, type RoutingRuleRow, type RoutingRuleValues } from './routing-rules.repository.js';
import { RoutingEvaluator } from './rule-evaluator.service.js';

import type { RoutingRuleInput, RoutingRuleTestInput } from './routing-rule-input.js';
import type { RoutingSubject, SkippedRule } from './rule-evaluation.js';
import type { RoutingActions, RoutingConditions } from '../platform-kernel/db/tables/routing.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Routing rules admin (US11, FR-059–FR-061, contracts/operations.yaml `/routing-rules*`).
 *
 * - Rules run in `position` order and the first match wins, so a new rule goes last and the list is
 *   always a gap-free 0..n-1 sequence (delete re-compacts). Writes of one tenant's list are
 *   serialized by an advisory lock.
 * - `groupId` and tag ids live in jsonb, without foreign keys: they are checked here at save time.
 *   An enabled rule needs an active group; a disabled one only an existing group, so a rule
 *   whose group was deactivated can still be switched off. Later deactivation is handled by the
 *   router, which skips such rules.
 * - `dryRun` goes through the same `RoutingEvaluator` as live routing and writes nothing.
 */

export const MAX_ROUTING_RULES = 100;

export interface RoutingRuleDto {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  actions: RoutingActions;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingDryRunDto {
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  actions: RoutingActions | null;
  skipped: { ruleId: string; ruleName: string; reason: SkippedRule['reason'] }[];
}

/** Stored and returned conditions: only the kinds that have entries, each deduplicated. */
function normalizeConditions(conditions: RoutingConditions): RoutingConditions {
  const out: RoutingConditions = {};
  const keep = <K extends keyof RoutingConditions>(key: K) => {
    const list = conditions[key];
    if (list !== undefined && list.length > 0) out[key] = [...new Set(list)];
  };
  keep('messageContainsAny');
  keep('messageContainsAll');
  keep('customerTagIds');
  keep('emailDomains');
  return out;
}

function normalizeActions(actions: RoutingActions): RoutingActions {
  return {
    groupId: actions.groupId,
    ...(actions.priority === undefined ? {} : { priority: actions.priority }),
    ...(actions.tagIds === undefined || actions.tagIds.length === 0 ? {} : { tagIds: [...new Set(actions.tagIds)] }),
  };
}

function toDto(row: RoutingRuleRow): RoutingRuleDto {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    conditions: normalizeConditions(row.conditions),
    actions: normalizeActions(row.actions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function valuesOf(input: RoutingRuleInput): RoutingRuleValues {
  return {
    name: input.name,
    enabled: input.enabled,
    conditions: normalizeConditions(input.conditions),
    actions: normalizeActions(input.actions),
  };
}

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly evaluator: RoutingEvaluator,
  ) {}

  list(ctx: TenantContext): Promise<RoutingRuleDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => (await new RoutingRuleWritesRepository(ctx).all(tx)).map(toDto));
  }

  create(ctx: TenantContext, input: RoutingRuleInput): Promise<RoutingRuleDto> {
    const values = valuesOf(input);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RoutingRuleWritesRepository(ctx);
      await repo.lockRules(tx);
      if ((await repo.count(tx)) >= MAX_ROUTING_RULES) {
        throw conflict('ROUTING_RULE_LIMIT', `A workspace can have at most ${MAX_ROUTING_RULES} routing rules`);
      }
      await this.assertReferences(repo, tx, values);
      const id = await repo.insert(tx, values, await repo.nextPosition(tx));
      await this.auditWrite(tx, 'routing_rule.created', id, values);
      return toDto(await this.reload(repo, tx, id));
    });
  }

  /** Full replace of the definition; the position stays (`PUT /routing-rules/order` moves it). */
  update(ctx: TenantContext, id: string, input: RoutingRuleInput): Promise<RoutingRuleDto> {
    const values = valuesOf(input);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RoutingRuleWritesRepository(ctx);
      await repo.lockRules(tx);
      if ((await repo.byId(tx, id)) === undefined) throw notFound('routing_rule');
      await this.assertReferences(repo, tx, values);
      await repo.update(tx, id, values);
      await this.auditWrite(tx, 'routing_rule.updated', id, values);
      return toDto(await this.reload(repo, tx, id));
    });
  }

  /** Hard delete; the rules after it move up one position. */
  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RoutingRuleWritesRepository(ctx);
      await repo.lockRules(tx);
      const row = await repo.byId(tx, id);
      if (row === undefined) throw notFound('routing_rule');
      await repo.delete(tx, id);
      await repo.setPositions(
        tx,
        (await repo.all(tx)).map((rule) => rule.id),
      );
      await this.audit.record(tx, {
        action: 'routing_rule.deleted',
        resourceType: 'routing_rule',
        resourceId: id,
        details: { name: row.name, position: row.position },
      });
    });
  }

  /**
   * `PUT /routing-rules/order`: `ids` must be exactly the tenant's rules, each once; position is
   * the index. Anything else (an unknown or other tenant's id, a missing rule) is 400 on `ids`,
   * which tells a client with a stale list to reload.
   */
  async reorder(ctx: TenantContext, ids: readonly string[]): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new RoutingRuleWritesRepository(ctx);
      await repo.lockRules(tx);
      const current = await repo.all(tx);
      const known = new Set(current.map((rule) => rule.id));
      if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
        throw validationFailed([{ path: 'ids', issue: 'invalid' }]);
      }
      await repo.setPositions(tx, ids);
      await this.audit.record(tx, {
        action: 'routing_rule.reordered',
        resourceType: 'routing_rule',
        details: { ruleCount: ids.length },
      });
    });
  }

  /**
   * `POST /routing-rules/test`: what routing would do for a first message from a customer. With
   * `customerId` the customer's own email and tags are used (404 `CUSTOMER_NOT_FOUND` for an
   * unknown or other tenant's id); otherwise the optional sample email and tags, or none.
   */
  dryRun(ctx: TenantContext, input: RoutingRuleTestInput): Promise<RoutingDryRunDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const subject = await this.subjectOf(ctx, tx, input);
      const { matched, skipped } = await this.evaluator.evaluate(tx, subject);
      return {
        matchedRuleId: matched?.ruleId ?? null,
        matchedRuleName: matched?.ruleName ?? null,
        actions:
          matched === null
            ? null
            : normalizeActions({ groupId: matched.groupId, ...(matched.priority === undefined ? {} : { priority: matched.priority }), tagIds: matched.tagIds }),
        skipped: skipped.map(({ ruleId, ruleName, reason }) => ({ ruleId, ruleName, reason })),
      };
    });
  }

  private async subjectOf(ctx: TenantContext, tx: TenantTransaction, input: RoutingRuleTestInput): Promise<RoutingSubject> {
    if (input.customerId === undefined) {
      return { messageBody: input.message, customerEmail: input.customerEmail ?? '', customerTagIds: input.customerTagIds ?? [] };
    }
    const customer = await new RoutingRuleWritesRepository(ctx).customer(tx, input.customerId);
    if (customer === undefined) throw notFound('customer');
    return this.evaluator.subjectFor(tx, customer, input.message);
  }

  /** The group and tags must be this tenant's (another tenant's id is unknown too). */
  private async assertReferences(repo: RoutingRuleWritesRepository, tx: TenantTransaction, values: RoutingRuleValues): Promise<void> {
    const details: ErrorDetail[] = [];
    const status = (await repo.groupStatuses(tx, [values.actions.groupId])).get(values.actions.groupId);
    if (status === undefined || (values.enabled && status !== 'active')) {
      details.push({ path: 'actions.groupId', issue: 'invalid_value' });
    }

    const conditionTags = values.conditions.customerTagIds ?? [];
    const actionTags = values.actions.tagIds ?? [];
    const existing = await repo.existingTagIds(tx, [...conditionTags, ...actionTags]);
    conditionTags.forEach((id, index) => {
      if (!existing.has(id)) details.push({ path: `conditions.customerTagIds.${index}`, issue: 'invalid_value' });
    });
    actionTags.forEach((id, index) => {
      if (!existing.has(id)) details.push({ path: `actions.tagIds.${index}`, issue: 'invalid_value' });
    });
    if (details.length > 0) throw validationFailed(details);
  }

  private async reload(repo: RoutingRuleWritesRepository, tx: TenantTransaction, id: string): Promise<RoutingRuleRow> {
    const row = await repo.byId(tx, id);
    if (row === undefined) throw new Error('Routing rule vanished inside its own transaction');
    return row;
  }

  private auditWrite(tx: TenantTransaction, action: string, id: string, values: RoutingRuleValues): Promise<void> {
    return this.audit.record(tx, {
      action,
      resourceType: 'routing_rule',
      resourceId: id,
      details: {
        name: values.name,
        enabled: values.enabled,
        groupId: values.actions.groupId,
        conditionKinds: Object.keys(values.conditions),
      },
    });
  }
}
