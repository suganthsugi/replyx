import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, validationFailed, type ErrorDetail } from '../../platform-kernel/http/app-error.js';

import { AutomationRulesRepository, type AutomationRuleRow, type AutomationRuleValues } from './automation-rules.repository.js';

import type { AutomationRuleInput } from './automation-rule-input.js';
import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { AutomationActions, AutomationTrigger } from '../../platform-kernel/db/tables/routing.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/**
 * Automation rules admin (US17, FR-088, contracts/operations.yaml `/automation-rules*`).
 *
 * - A new rule goes last; rules run in `position` order. Writes of one tenant's list are
 *   serialized by an advisory lock, and a workspace has at most `MAX_AUTOMATION_RULES`.
 * - Ids inside `actions` live in jsonb without foreign keys, so they are checked here: the group
 *   must exist (and be active for an enabled rule), the owner and notified users must be active
 *   staff, and the tags must exist. Whether the owner may own the ticket's group is checked when
 *   the rule runs, like a manual assignment (a run that is refused is recorded as failed).
 * - Every write is audited as `automation_rule.created` / `.updated` / `.deleted`.
 */

export const MAX_AUTOMATION_RULES = 100;

export interface AutomationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  trigger: AutomationTrigger;
  conditions: JsonValue | null;
  actions: AutomationActions;
  createdAt: string;
  updatedAt: string;
}

export function toAutomationRuleDto(row: AutomationRuleRow): AutomationRuleDto {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Drops empty or meaningless fields and duplicate ids, so the stored rule is canonical. */
function normalizeActions(actions: AutomationActions): AutomationActions {
  const out: AutomationActions = {};
  if (actions.groupId !== undefined) out.groupId = actions.groupId;
  if (actions.ownerId !== undefined) out.ownerId = actions.ownerId;
  if (actions.priority !== undefined) out.priority = actions.priority;
  if (actions.state !== undefined) out.state = actions.state;
  if (actions.pendingInHours !== undefined && (actions.state === 'pending_reminder' || actions.state === 'pending_close')) out.pendingInHours = actions.pendingInHours;
  if (actions.addTagIds !== undefined) out.addTagIds = [...new Set(actions.addTagIds)];
  if (actions.autoReply !== undefined) out.autoReply = actions.autoReply;
  if (actions.notifyUserIds !== undefined) out.notifyUserIds = [...new Set(actions.notifyUserIds)];
  return out;
}

function valuesOf(input: AutomationRuleInput): AutomationRuleValues {
  return {
    name: input.name,
    enabled: input.enabled,
    trigger: input.trigger,
    conditions: input.conditions as JsonValue | null,
    actions: normalizeActions(input.actions),
  };
}

@Injectable()
export class AutomationRulesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  list(ctx: TenantContext): Promise<AutomationRuleDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => (await new AutomationRulesRepository(ctx).all(tx)).map(toAutomationRuleDto));
  }

  create(ctx: TenantContext, input: AutomationRuleInput): Promise<AutomationRuleDto> {
    const values = valuesOf(input);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AutomationRulesRepository(ctx);
      await repo.lockRules(tx);
      if ((await repo.count(tx)) >= MAX_AUTOMATION_RULES) {
        throw conflict('AUTOMATION_RULE_LIMIT', `A workspace can have at most ${MAX_AUTOMATION_RULES} automation rules`);
      }
      await this.assertReferences(ctx, tx, values);
      const id = await repo.insert(tx, values, await repo.nextPosition(tx));
      await this.auditWrite(tx, 'automation_rule.created', id, values);
      return toAutomationRuleDto(await this.reload(repo, tx, id));
    });
  }

  /** Full replace of the definition; the position stays. */
  update(ctx: TenantContext, id: string, input: AutomationRuleInput): Promise<AutomationRuleDto> {
    const values = valuesOf(input);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AutomationRulesRepository(ctx);
      await repo.lockRules(tx);
      if ((await repo.byId(tx, id)) === undefined) throw notFound('automation_rule');
      await this.assertReferences(ctx, tx, values);
      await repo.update(tx, id, values);
      await this.auditWrite(tx, 'automation_rule.updated', id, values);
      return toAutomationRuleDto(await this.reload(repo, tx, id));
    });
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AutomationRulesRepository(ctx);
      await repo.lockRules(tx);
      const row = await repo.byId(tx, id);
      if (row === undefined) throw notFound('automation_rule');
      await repo.delete(tx, id);
      await this.audit.record(tx, { action: 'automation_rule.deleted', resourceType: 'automation_rule', resourceId: id, details: { name: row.name } });
    });
  }

  private async assertReferences(ctx: TenantContext, tx: TenantTransaction, values: AutomationRuleValues): Promise<void> {
    const refs = new ReferenceRepository(ctx);
    const details: ErrorDetail[] = [];
    const { actions } = values;
    if (actions.groupId !== undefined && actions.groupId !== null) {
      const status = await refs.groupStatus(tx, actions.groupId);
      if (status === undefined || (values.enabled && status !== 'active')) details.push({ path: 'actions.groupId', issue: 'invalid_value' });
    }
    const staffIds = [...(actions.ownerId === undefined || actions.ownerId === null ? [] : [actions.ownerId]), ...(actions.notifyUserIds ?? [])];
    const staff = await refs.activeStaff(tx, staffIds);
    if (actions.ownerId !== undefined && actions.ownerId !== null && !staff.has(actions.ownerId)) details.push({ path: 'actions.ownerId', issue: 'invalid_value' });
    (actions.notifyUserIds ?? []).forEach((id, index) => {
      if (!staff.has(id)) details.push({ path: `actions.notifyUserIds.${index}`, issue: 'invalid_value' });
    });
    const tags = await refs.existingTags(tx, actions.addTagIds ?? []);
    (actions.addTagIds ?? []).forEach((id, index) => {
      if (!tags.has(id)) details.push({ path: `actions.addTagIds.${index}`, issue: 'invalid_value' });
    });
    if (details.length > 0) throw validationFailed(details);
  }

  private async reload(repo: AutomationRulesRepository, tx: TenantTransaction, id: string): Promise<AutomationRuleRow> {
    const row = await repo.byId(tx, id);
    if (row === undefined) throw new Error('Automation rule vanished inside its own transaction');
    return row;
  }

  private auditWrite(tx: TenantTransaction, action: string, id: string, values: AutomationRuleValues): Promise<void> {
    return this.audit.record(tx, {
      action,
      resourceType: 'automation_rule',
      resourceId: id,
      details: { name: values.name, enabled: values.enabled, trigger: values.trigger.event, actionKinds: Object.keys(values.actions) },
    });
  }
}

class ReferenceRepository extends TenantRepository {
  async groupStatus(tx: TenantTransaction, groupId: string): Promise<'active' | 'inactive' | undefined> {
    const row = await this.selectFrom(tx, 'groups').select('groups.status').where('groups.id', '=', groupId).executeTakeFirst();
    return row?.status;
  }

  async activeStaff(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.id', 'in', [...new Set(ids)])
      .where('users.kind', '=', 'staff')
      .where('users.status', '=', 'active')
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  async existingTags(tx: TenantTransaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.selectFrom(tx, 'tags').select('tags.id').where('tags.id', 'in', [...new Set(ids)]).execute();
    return new Set(rows.map((row) => row.id));
  }
}
