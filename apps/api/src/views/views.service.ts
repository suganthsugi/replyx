import { Injectable } from '@nestjs/common';

import { PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';

import { ViewCountsService } from './view-counts.service.js';
import { canSeeView, viewerIdOf, visibleViews } from './view-visibility.js';
import { ViewsRepository, ViewWritesRepository, type ViewRow } from './views.repository.js';

import type { ConditionGroup } from './view-compiler.js';
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

@Injectable()
export class ViewsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly viewCounts: ViewCountsService,
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
