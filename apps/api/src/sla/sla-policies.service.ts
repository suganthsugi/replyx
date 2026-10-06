import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound, validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';
import { isConditionGroup, type ConditionExpression } from '../views/condition-schema.js';
import { validateConditions } from '../views/view-compiler.js';

import { SlaAdminRepository, type SlaPolicyRecord, type SlaPolicyValues } from './sla-admin.repository.js';
import { SlaReapplyService } from './sla-reapply.service.js';

import type { SlaPolicyInput } from './sla-policy-input.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * SLA policies admin (US12, FR-084, contracts/operations.yaml `/sla-policies*`, permissions
 * `sla_policy.view/create/edit/delete`).
 *
 * - Policies are evaluated in `position` order and the first match wins (policy-matching.ts). A new
 *   policy goes last unless `position` is given; `position` on update moves it (ties break on id).
 * - Conditions are the shared condition tree, restricted to what matching evaluates: `priority`
 *   and `group` with `is` / `is_not`. Group ids must be this tenant's groups (or `ungrouped`).
 * - The calendar must be this tenant's (another tenant's id is unknown too): 400 on
 *   `businessHoursId`.
 * - After a create, update or delete, open tickets' SLA rows are recomputed with `reset: true`
 *   (`SlaReapplyService`, after commit). Deleting a policy deletes its `ticket_sla` rows (FK cascade).
 */

export interface SlaPolicyDto {
  id: string;
  name: string;
  position: number;
  conditions: unknown;
  businessHoursId: string;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  warningPercent: number;
}

function toDto(record: SlaPolicyRecord): SlaPolicyDto {
  return { ...record };
}

function valuesOf(input: SlaPolicyInput, conditions: ConditionExpression): SlaPolicyValues {
  return {
    name: input.name,
    conditions,
    businessHoursId: input.businessHoursId,
    firstResponseMinutes: input.firstResponseMinutes ?? null,
    nextResponseMinutes: input.nextResponseMinutes ?? null,
    resolutionMinutes: input.resolutionMinutes ?? null,
    warningPercent: input.warningPercent,
  };
}

const POLICY_FIELDS: readonly string[] = ['priority', 'group'];
const POLICY_OPERATORS: readonly string[] = ['is', 'is_not'];

/** Leaves the policy matcher can't evaluate would never match: reject them, and collect group ids. */
function inspect(node: ConditionExpression, path: string, groupIds: Map<string, string>, details: ErrorDetail[]): void {
  if (isConditionGroup(node)) {
    node.items.forEach((item, index) => inspect(item, `${path}.items.${index}`, groupIds, details));
    return;
  }
  if (!POLICY_FIELDS.includes(node.field)) {
    details.push({ path: `${path}.field`, issue: 'invalid_value' });
    return;
  }
  if (!POLICY_OPERATORS.includes(node.operator)) {
    details.push({ path: `${path}.operator`, issue: 'invalid_value' });
    return;
  }
  if (node.field === 'group') {
    const values = Array.isArray(node.value) ? node.value : [node.value];
    values.forEach((value, index) => {
      if (typeof value === 'string' && value !== 'ungrouped') {
        groupIds.set(Array.isArray(node.value) ? `${path}.value.${index}` : `${path}.value`, value);
      }
    });
  }
}

@Injectable()
export class SlaPoliciesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly reapply: SlaReapplyService,
  ) {}

  list(ctx: TenantContext): Promise<SlaPolicyDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => (await new SlaAdminRepository(ctx).listPolicies(tx)).map(toDto));
  }

  async create(ctx: TenantContext, input: SlaPolicyInput): Promise<SlaPolicyDto> {
    const conditions = validateConditions(input.conditions);
    const values = valuesOf(input, conditions);
    const created = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      await this.assertReferences(repo, tx, values, conditions);
      const position = input.position ?? (await repo.nextPosition(tx));
      const id = await repo.insertPolicy(tx, values, position);
      await this.auditWrite(tx, 'sla_policy.created', id, values, position);
      return toDto(await this.reload(repo, tx, id));
    });
    await this.reapply.reapplyToOpenTickets(ctx);
    return created;
  }

  /** Full replace of the definition; the position changes only when `position` is sent. */
  async update(ctx: TenantContext, id: string, input: SlaPolicyInput): Promise<SlaPolicyDto> {
    const conditions = validateConditions(input.conditions);
    const values = valuesOf(input, conditions);
    const updated = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      if ((await repo.policyById(tx, id)) === undefined) throw notFound('sla_policy');
      await this.assertReferences(repo, tx, values, conditions);
      await repo.updatePolicy(tx, id, values, input.position);
      const reloaded = await this.reload(repo, tx, id);
      await this.auditWrite(tx, 'sla_policy.updated', id, values, reloaded.position);
      return toDto(reloaded);
    });
    await this.reapply.reapplyToOpenTickets(ctx);
    return updated;
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SlaAdminRepository(ctx);
      await repo.lockConfig(tx);
      const row = await repo.policyById(tx, id);
      if (row === undefined) throw notFound('sla_policy');
      await repo.deletePolicy(tx, id);
      await this.audit.record(tx, {
        action: 'sla_policy.deleted',
        resourceType: 'sla_policy',
        resourceId: id,
        details: { name: row.name, position: row.position },
      });
    });
    await this.reapply.reapplyToOpenTickets(ctx);
  }

  /** Condition semantics, the group ids in them, and the calendar. */
  private async assertReferences(repo: SlaAdminRepository, tx: TenantTransaction, values: SlaPolicyValues, conditions: ConditionExpression): Promise<void> {
    const details: ErrorDetail[] = [];
    const groupIds = new Map<string, string>();
    inspect(conditions, 'conditions', groupIds, details);

    const existing = await repo.existingGroupIds(tx, [...new Set(groupIds.values())]);
    for (const [path, groupId] of groupIds) {
      if (!existing.has(groupId)) details.push({ path, issue: 'invalid_value' });
    }
    if ((await repo.businessHoursById(tx, values.businessHoursId)) === undefined) {
      details.push({ path: 'businessHoursId', issue: 'invalid_value' });
    }
    if (details.length > 0) throw validationFailed(details);
  }

  private async reload(repo: SlaAdminRepository, tx: TenantTransaction, id: string): Promise<SlaPolicyRecord> {
    const row = await repo.policyById(tx, id);
    if (row === undefined) throw new Error('SLA policy vanished inside its own transaction');
    return row;
  }

  private auditWrite(tx: TenantTransaction, action: string, id: string, values: SlaPolicyValues, position: number): Promise<void> {
    return this.audit.record(tx, {
      action,
      resourceType: 'sla_policy',
      resourceId: id,
      details: {
        name: values.name,
        position,
        businessHoursId: values.businessHoursId,
        warningPercent: values.warningPercent,
      },
    });
  }
}
