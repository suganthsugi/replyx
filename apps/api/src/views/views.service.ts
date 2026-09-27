import { Injectable } from '@nestjs/common';

import { PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { UnitOfWork } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';

import { ViewCountsService } from './view-counts.service.js';
import { canSeeView, viewerIdOf, visibleViews } from './view-visibility.js';
import { ViewsRepository, type ViewRow } from './views.repository.js';

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

function toViewDto(row: ViewRow, viewerId: string, access: EffectiveAccess, count: number): ViewDto {
  const editable = row.visibility === 'personal' ? row.ownerId === viewerId : access.permissions.has('view.edit');
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
}
