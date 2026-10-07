import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound, validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';
import { ViewVisibilityRepository } from '../views/view-visibility.js';

import { MacrosRepository, type MacroRow, type MacroValues } from './macros.repository.js';

import type { MacroInput } from './macro-input.js';
import type { MacroActions, MacroVisibility } from '../platform-kernel/db/tables/macros.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * `/macros` (contracts/tickets.yaml, T236, FR-068): reply templates with field changes.
 *
 * - Reads and writes are limited to the macros the caller can see (`all_staff`; `roles` when they
 *   hold one of the shared roles; `groups` when they have view access on one of the shared groups;
 *   always the creator). An invisible macro is 404 `MACRO_NOT_FOUND`, the same as a missing one
 *   (constitution I). The route permission (`macro.view|create|edit|delete`) gates the verb.
 * - Roles, groups and tags a macro names must belong to the tenant (else 400).
 * - Operators under a support-access grant read every macro (read-only, FR-001a).
 */

export interface MacroDto {
  id: string;
  name: string;
  body: string;
  actions: MacroActions;
  visibility: MacroVisibility;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
}

function toMacroDto(row: MacroRow): MacroDto {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    actions: row.actions,
    visibility: row.visibility,
    sharedRoleIds: [...row.sharedRoleIds],
    sharedGroupIds: [...row.sharedGroupIds],
  };
}

function isPending(state: MacroActions['state']): boolean {
  return state === 'pending_reminder' || state === 'pending_close';
}

/** Only the keys that do something: `assignToMe: false` and empty tag lists are dropped. */
function cleanActions(actions: MacroInput['actions']): MacroActions {
  const clean: MacroActions = {};
  if (actions.state !== undefined) clean.state = actions.state;
  if (actions.pendingInHours !== undefined) clean.pendingInHours = actions.pendingInHours;
  if (actions.priority !== undefined) clean.priority = actions.priority;
  const tagIds = [...new Set(actions.addTagIds ?? [])];
  if (tagIds.length > 0) clean.addTagIds = tagIds;
  if (actions.assignToMe === true) clean.assignToMe = true;
  return clean;
}

/**
 * The request as it will be stored: only the list that matches the visibility is kept, `roles` /
 * `groups` need at least one id, a pending state needs `pendingInHours` (and only a pending state
 * takes it), and the macro must insert a reply or change a field.
 */
function valuesOf(input: MacroInput): MacroValues {
  const actions = cleanActions(input.actions);
  const details: ErrorDetail[] = [];
  if (isPending(actions.state) && actions.pendingInHours === undefined) details.push({ path: 'actions.pendingInHours', issue: 'required' });
  if (!isPending(actions.state) && actions.pendingInHours !== undefined) details.push({ path: 'actions.pendingInHours', issue: 'invalid' });
  const sharedRoleIds = input.visibility === 'roles' ? [...new Set(input.sharedRoleIds ?? [])] : [];
  const sharedGroupIds = input.visibility === 'groups' ? [...new Set(input.sharedGroupIds ?? [])] : [];
  if (input.visibility === 'roles' && sharedRoleIds.length === 0) details.push({ path: 'sharedRoleIds', issue: 'too_few' });
  if (input.visibility === 'groups' && sharedGroupIds.length === 0) details.push({ path: 'sharedGroupIds', issue: 'too_few' });
  if (input.body.trim() === '' && Object.keys(actions).length === 0) details.push({ path: 'body', issue: 'required' });
  if (details.length > 0) throw validationFailed(details);
  return { name: input.name, body: input.body, actions, visibility: input.visibility, sharedRoleIds, sharedGroupIds };
}

/** Whether `viewerId` sees the macro: the same sharing rules as views, plus the creator. */
export function canSeeMacro(ctx: TenantContext, tx: TenantTransaction, macro: MacroRow, viewerId: string, access: EffectiveAccess): Promise<boolean> {
  return new ViewVisibilityRepository(ctx).canSee(tx, { ...macro, ownerId: macro.createdBy }, viewerId, access);
}

@Injectable()
export class MacrosService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext): Promise<MacroDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rows = await new MacrosRepository(ctx).listAll(tx);
      if (ctx.actor.kind === 'operator') return rows.map(toMacroDto);
      const viewerId = this.viewerId(ctx);
      const access = await this.policy.effectiveAccessIn(ctx, tx, viewerId);
      const visible: MacroRow[] = [];
      for (const row of rows) {
        if (await canSeeMacro(ctx, tx, row, viewerId, access)) visible.push(row);
      }
      return visible.map(toMacroDto);
    });
  }

  async create(ctx: TenantContext, input: MacroInput): Promise<MacroDto> {
    const values = valuesOf(input);
    const viewerId = this.viewerId(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      await this.assertTargetsExist(ctx, tx, values);
      const repo = new MacrosRepository(ctx);
      const id = await repo.insert(tx, values, viewerId);
      const created = await this.reload(ctx, tx, id);
      await this.auditWrite(tx, 'macro.created', created);
      return toMacroDto(created);
    });
  }

  async update(ctx: TenantContext, id: string, input: MacroInput): Promise<MacroDto> {
    const values = valuesOf(input);
    const viewerId = this.viewerId(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      await this.visibleMacro(ctx, tx, id, viewerId);
      await this.assertTargetsExist(ctx, tx, values);
      await new MacrosRepository(ctx).update(tx, id, values);
      const after = await this.reload(ctx, tx, id);
      await this.auditWrite(tx, 'macro.updated', after);
      return toMacroDto(after);
    });
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    const viewerId = this.viewerId(ctx);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const row = await this.visibleMacro(ctx, tx, id, viewerId);
      await new MacrosRepository(ctx).delete(tx, id);
      await this.auditWrite(tx, 'macro.deleted', row);
    });
  }

  /**
   * The macro if `viewerId` may see it; otherwise the same 404 as a missing one. Also used by
   * `MacroApplyService`, inside its transaction.
   */
  async visibleMacro(ctx: TenantContext, tx: TenantTransaction, id: string, viewerId: string): Promise<MacroRow> {
    const row = await new MacrosRepository(ctx).byId(tx, id);
    if (row === undefined) throw notFound('macro');
    const access = await this.policy.effectiveAccessIn(ctx, tx, viewerId);
    if (!(await canSeeMacro(ctx, tx, row, viewerId, access))) throw notFound('macro');
    return row;
  }

  /** Roles, groups and tags a macro names must be this tenant's (another tenant's id is unknown too). */
  private async assertTargetsExist(ctx: TenantContext, tx: TenantTransaction, values: MacroValues): Promise<void> {
    const repo = new MacrosRepository(ctx);
    const details: ErrorDetail[] = [];
    const missing = (ids: readonly string[], known: Set<string>, path: string) =>
      ids.forEach((id, index) => {
        if (!known.has(id)) details.push({ path: `${path}.${index}`, issue: 'invalid_value' });
      });
    missing(values.sharedRoleIds, await repo.existingRoleIds(tx, values.sharedRoleIds), 'sharedRoleIds');
    missing(values.sharedGroupIds, await repo.existingGroupIds(tx, values.sharedGroupIds), 'sharedGroupIds');
    const tagIds = values.actions.addTagIds ?? [];
    missing(tagIds, await repo.existingTagIds(tx, tagIds), 'actions.addTagIds');
    if (details.length > 0) throw validationFailed(details);
  }

  private async reload(ctx: TenantContext, tx: TenantTransaction, id: string): Promise<MacroRow> {
    const row = await new MacrosRepository(ctx).byId(tx, id);
    if (row === undefined) throw new Error('Macro vanished inside its own transaction');
    return row;
  }

  /** Never the body: audit details carry no message text. */
  private async auditWrite(tx: TenantTransaction, action: string, macro: MacroRow): Promise<void> {
    await this.audit.record(tx, {
      action,
      resourceType: 'macro',
      resourceId: macro.id,
      details: {
        name: macro.name,
        visibility: macro.visibility,
        sharedRoleIds: [...macro.sharedRoleIds],
        sharedGroupIds: [...macro.sharedGroupIds],
      },
    });
  }

  private viewerId(ctx: TenantContext): string {
    if (ctx.actor.kind !== 'user') throw new Error('Macros are managed by user actors');
    return ctx.actor.id;
  }
}
