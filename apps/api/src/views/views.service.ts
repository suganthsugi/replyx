import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied, validationFailed, type ErrorDetail } from '../platform-kernel/http/app-error.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { isConditionGroup } from './condition-schema.js';
import { validateConditions } from './view-compiler.js';
import { ViewCountsService } from './view-counts.service.js';
import { canSeeView, viewerIdOf, visibleViews } from './view-visibility.js';
import { ViewsRepository, ViewWritesRepository, type ViewRow, type ViewValues } from './views.repository.js';

import type { ConditionGroup } from './view-compiler.js';
import type { ViewInput } from './view-input.js';
import type { ViewVisibility } from '../platform-kernel/db/tables/tags-views.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * `GET /views` and `GET /views/{id}` (contracts/tickets.yaml, T141): views visible to the caller
 * (FR-076, FR-077), each with its ticket count (research D13, cached by `ViewCountsService`). An
 * unknown or invisible view is 404 `VIEW_NOT_FOUND`, same as any other invisible resource
 * (constitution I).
 */

export interface ViewDto {
  id: string;
  name: string;
  description: string | null;
  visibility: ViewVisibility;
  sharedRoleIds: string[];
  sharedGroupIds: string[];
  conditions: ConditionGroup;
  sort: { field: string; direction: 'asc' | 'desc' }[];
  columns: string[];
  system: string | null;
  count: number;
  position: number;
  hidden: boolean;
  editable: boolean;
}

/**
 * Who may reorder, hide or edit a view (FR-073, `editable` in `ViewDto`): its owner for a personal
 * view; `view.edit` for a shared one (default views included), since the change reaches everyone
 * it is shared with.
 */
function canArrange(row: ViewRow, viewerId: string, access: EffectiveAccess): boolean {
  return row.visibility === 'personal' ? row.ownerId === viewerId : access.permissions.has('view.edit');
}

function toViewDto(row: ViewRow, viewerId: string, access: EffectiveAccess, count: number): ViewDto {
  const editable = canArrange(row, viewerId, access);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    sharedRoleIds: [...row.sharedRoleIds],
    sharedGroupIds: [...row.sharedGroupIds],
    conditions: row.conditions,
    sort: row.sort,
    columns: [...row.columns],
    system: row.systemKey,
    count,
    position: row.position,
    hidden: row.hidden,
    editable,
  };
}

/** The sharing of a view, as compared and validated on write. */
interface Sharing {
  visibility: ViewVisibility;
  sharedRoleIds: readonly string[];
  sharedGroupIds: readonly string[];
}

/**
 * The owner an edited view keeps: the editor's own once it is (or becomes) personal, otherwise the
 * stored one — an editor with `view.edit` doesn't take a colleague's view, and a default view
 * stays ownerless.
 */
function ownerAfter(before: ViewRow, values: ViewValues, viewerId: string): string | null {
  if (before.systemKey !== null) return before.ownerId;
  return values.visibility === 'personal' ? viewerId : before.ownerId;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function sameSharing(a: Sharing, b: Sharing): boolean {
  return a.visibility === b.visibility && sameIds(a.sharedRoleIds, b.sharedRoleIds) && sameIds(a.sharedGroupIds, b.sharedGroupIds);
}

/**
 * The request as it will be stored: only the list that matches the visibility is kept (a list
 * for another visibility is dropped, unvalidated), `roles`/`groups` need at least one id, and the
 * conditions pass the semantic pass of `validateConditions` (400 before any permission or data check).
 */
function valuesOf(input: ViewInput, viewerId: string): ViewValues {
  const tree = validateConditions(input.conditions);
  if (!isConditionGroup(tree)) throw validationFailed([{ path: 'conditions', issue: 'invalid' }]);
  const sharedRoleIds = input.visibility === 'roles' ? [...new Set(input.sharedRoleIds ?? [])] : [];
  const sharedGroupIds = input.visibility === 'groups' ? [...new Set(input.sharedGroupIds ?? [])] : [];
  if (input.visibility === 'roles' && sharedRoleIds.length === 0) throw validationFailed([{ path: 'sharedRoleIds', issue: 'too_few' }]);
  if (input.visibility === 'groups' && sharedGroupIds.length === 0) throw validationFailed([{ path: 'sharedGroupIds', issue: 'too_few' }]);
  return {
    name: input.name,
    description: input.description === undefined || input.description === '' ? null : input.description,
    // The creator owns the view whatever its visibility, so a shared view stays visible to them
    // (data-model.md "views"); `update` keeps the stored owner instead (`ownerAfter`).
    ownerId: viewerId,
    visibility: input.visibility,
    sharedRoleIds,
    sharedGroupIds,
    conditions: tree,
    sort: input.sort,
    columns: input.columns,
  };
}

@Injectable()
export class ViewsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly viewCounts: ViewCountsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(ctx: TenantContext): Promise<ViewDto[]> {
    const viewerId = viewerIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const access = await this.policy.effectiveAccess(ctx, viewerId);
      const visible = await visibleViews(ctx, tx, viewerId, access);
      const counts = await this.viewCounts.countsFor(ctx, tx, access.accessVersion, visible);
      return visible.map((row) => toViewDto(row, viewerId, access, counts[row.id] ?? 0));
    });
  }

  async get(ctx: TenantContext, id: string): Promise<ViewDto> {
    const viewerId = viewerIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await new ViewsRepository(ctx).byId(tx, id);
      if (row === undefined) throw notFound('view');
      const access = await this.policy.effectiveAccess(ctx, viewerId);
      if (!(await canSeeView(ctx, tx, row, viewerId, access))) throw notFound('view');
      const counts = await this.viewCounts.countsFor(ctx, tx, access.accessVersion, [row]);
      return toViewDto(row, viewerId, access, counts[row.id] ?? 0);
    });
  }

  /**
   * `POST /views` (US10): a personal view is the caller's own; sharing it (`all_staff`, `roles`,
   * `groups`) also needs `view.share`, and the roles or groups must exist in the tenant (else 400).
   * The route already requires `view.create`. Other viewers' counts are refreshed (`announce`).
   */
  async create(ctx: TenantContext, input: ViewInput): Promise<ViewDto> {
    const viewerId = viewerIdOf(ctx);
    const values = valuesOf(input, viewerId);
    const access = await this.policy.effectiveAccess(ctx, viewerId);
    if (values.visibility !== 'personal' && !access.permissions.has('view.share')) throw permissionDenied();

    const { dto, viewers } = await this.unitOfWork.withTenant(ctx, async (tx) => {
      await this.assertSharedTargetsExist(ctx, tx, values);
      const id = await new ViewWritesRepository(ctx).insert(tx, values);
      const created = await this.reload(ctx, tx, id);
      await this.auditWrite(tx, 'view.created', created, undefined);
      const viewers = await this.announce(ctx, tx, viewerId, undefined, created);
      const count = await this.viewCounts.countConditions(ctx, tx, created.conditions);
      return { dto: toViewDto(created, viewerId, access, count), viewers };
    });
    await this.viewCounts.invalidate(ctx.tenantId, viewers);
    return dto;
  }

  /**
   * `PUT /views/{id}` (US10): replaces the definition; position and hidden stay (they are
   * arranging, `PUT /views/order`). Invisible: 404 `VIEW_NOT_FOUND`. Then:
   * - a default view needs `view.edit` and keeps its sharing (400 on `visibility` otherwise);
   * - a personal view is its owner's, and sharing it needs `view.share`;
   * - a shared view needs `view.edit`, plus `view.share` when its sharing changes, or `view.create`
   *   when it becomes personal (the editor becomes its owner).
   */
  async update(ctx: TenantContext, id: string, input: ViewInput): Promise<ViewDto> {
    const viewerId = viewerIdOf(ctx);
    const values = valuesOf(input, viewerId);
    const access = await this.policy.effectiveAccess(ctx, viewerId);

    const { dto, viewers } = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const before = await this.visibleView(ctx, tx, id, viewerId, access);
      this.authorizeUpdate(before, values, viewerId, access);
      await this.assertSharedTargetsExist(ctx, tx, values);
      await new ViewWritesRepository(ctx).update(tx, id, { ...values, ownerId: ownerAfter(before, values, viewerId) });
      const after = await this.reload(ctx, tx, id);
      await this.auditWrite(tx, 'view.updated', after, before);
      const viewers = await this.announce(ctx, tx, viewerId, before, after);
      const count = await this.viewCounts.countConditions(ctx, tx, after.conditions);
      return { dto: toViewDto(after, viewerId, access, count), viewers };
    });
    await this.viewCounts.invalidate(ctx.tenantId, viewers);
    return dto;
  }

  /**
   * `POST /views/preview-count`: how many tickets an unsaved tree matches for the caller, through
   * the same path as view counts (the caller's access filter AND the tree), uncached.
   */
  async previewCount(ctx: TenantContext, conditions: unknown): Promise<{ count: number }> {
    viewerIdOf(ctx);
    const tree = validateConditions(conditions);
    const count = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.viewCounts.countConditions(ctx, tx, tree));
    return { count };
  }

  private authorizeUpdate(before: ViewRow, values: ViewValues, viewerId: string, access: EffectiveAccess): void {
    const has = (key: string) => access.permissions.has(key);
    if (before.systemKey !== null) {
      if (!has('view.edit')) throw permissionDenied();
      if (!sameSharing(before, values)) throw validationFailed([{ path: 'visibility', issue: 'invalid_value' }]);
      return;
    }
    if (before.visibility === 'personal') {
      if (before.ownerId !== viewerId) throw permissionDenied();
      if (values.visibility !== 'personal' && !has('view.share')) throw permissionDenied();
      return;
    }
    if (!has('view.edit')) throw permissionDenied();
    if (values.visibility === 'personal') {
      if (!has('view.create')) throw permissionDenied();
    } else if (!sameSharing(before, values) && !has('view.share')) {
      throw permissionDenied();
    }
  }

  /** Roles and groups a shared view names must be this tenant's (another tenant's id is unknown too). */
  private async assertSharedTargetsExist(ctx: TenantContext, tx: TenantTransaction, values: ViewValues): Promise<void> {
    const writes = new ViewWritesRepository(ctx);
    const details: ErrorDetail[] = [];
    const missing = (ids: readonly string[], known: Set<string>, path: string) =>
      ids.forEach((id, index) => {
        if (!known.has(id)) details.push({ path: `${path}.${index}`, issue: 'invalid_value' });
      });
    missing(values.sharedRoleIds, await writes.existingRoleIds(tx, values.sharedRoleIds), 'sharedRoleIds');
    missing(values.sharedGroupIds, await writes.existingGroupIds(tx, values.sharedGroupIds), 'sharedGroupIds');
    if (details.length > 0) throw validationFailed(details);
  }

  private async reload(ctx: TenantContext, tx: TenantTransaction, id: string): Promise<ViewRow> {
    const row = await new ViewsRepository(ctx).byId(tx, id);
    if (row === undefined) throw new Error('View vanished inside its own transaction');
    return row;
  }

  /** Audit entry for a write that involves sharing (a purely personal view is the owner's business). */
  private async auditWrite(tx: TenantTransaction, action: string, view: ViewRow, before: ViewRow | undefined): Promise<void> {
    if (view.visibility === 'personal' && (before === undefined || before.visibility === 'personal')) return;
    await this.audit.record(tx, {
      action,
      resourceType: 'view',
      resourceId: view.id,
      details: {
        name: view.name,
        visibility: view.visibility,
        sharedRoleIds: [...view.sharedRoleIds],
        sharedGroupIds: [...view.sharedGroupIds],
        system: view.systemKey,
      },
    });
  }

  /**
   * Tells everyone who sees the view before or after the write (and the writer) to refetch: a
   * `views.counts_changed` hint on each viewer's `views` stream, appended in the write's
   * transaction (persist before publish). Returns those viewers, whose cached counts the caller
   * drops after commit. Naming only viewers who see the view keeps its id from anyone else.
   */
  private async announce(
    ctx: TenantContext,
    tx: TenantTransaction,
    viewerId: string,
    before: ViewRow | undefined,
    after: ViewRow,
  ): Promise<string[]> {
    const rows = before === undefined ? [after] : [before, after];
    const viewers = new Set<string>([viewerId]);
    if (rows.some((row) => row.visibility !== 'personal')) {
      for (const userId of await new ViewWritesRepository(ctx).activeStaffIds(tx)) {
        if (viewers.has(userId)) continue;
        const access = await this.policy.effectiveAccessIn(ctx, tx, userId);
        for (const row of rows) {
          if (await canSeeView(ctx, tx, row, userId, access)) {
            viewers.add(userId);
            break;
          }
        }
      }
    }
    await this.outbox.append(tx, {
      type: 'views.counts_changed',
      actor: { kind: 'system' },
      payload: { viewIds: [after.id] },
      streams: [...viewers].map((userId): `views:${string}` => `views:${userId}`),
    });
    return [...viewers];
  }

  /**
   * `PUT /views/order` (FR-073, T160): positions and hidden flags, all or nothing. Every id must be
   * a view the caller sees (else 404 `VIEW_NOT_FOUND`) and may arrange (else 403). Position and
   * hidden belong to the view, so arranging a shared view does so for everyone who sees it.
   */
  async reorder(ctx: TenantContext, items: readonly { id: string; position: number; hidden: boolean }[]): Promise<void> {
    const viewerId = viewerIdOf(ctx);
    const access = await this.policy.effectiveAccess(ctx, viewerId);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      for (const item of items) {
        const row = await this.visibleView(ctx, tx, item.id, viewerId, access);
        if (!canArrange(row, viewerId, access)) throw permissionDenied();
      }
      const writes = new ViewWritesRepository(ctx);
      for (const item of items) await writes.setOrder(tx, item.id, item.position, item.hidden);
    });
  }

  /**
   * `DELETE /views/{id}` (T160): a default view can only be hidden (409 `SYSTEM_VIEW`); a personal
   * view is its owner's to delete; a shared one needs `view.delete`.
   */
  async delete(ctx: TenantContext, id: string): Promise<void> {
    const viewerId = viewerIdOf(ctx);
    const access = await this.policy.effectiveAccess(ctx, viewerId);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const row = await this.visibleView(ctx, tx, id, viewerId, access);
      if (row.systemKey !== null) throw conflict('SYSTEM_VIEW', 'Default views can be hidden, not deleted');
      const allowed = row.visibility === 'personal' ? row.ownerId === viewerId : access.permissions.has('view.delete');
      if (!allowed) throw permissionDenied();
      await new ViewWritesRepository(ctx).delete(tx, id);
    });
  }

  private async visibleView(ctx: TenantContext, tx: TenantTransaction, id: string, viewerId: string, access: EffectiveAccess): Promise<ViewRow> {
    const row = await new ViewsRepository(ctx).byId(tx, id);
    if (row === undefined || !(await canSeeView(ctx, tx, row, viewerId, access))) throw notFound('view');
    return row;
  }
}
