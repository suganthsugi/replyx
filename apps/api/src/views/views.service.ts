import { Injectable } from '@nestjs/common';

import { PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';

import { ViewCompiler, type ConditionGroup } from './view-compiler.js';
import { ViewVisibilityRepository } from './view-visibility.js';
import { TicketCountRepository, ViewsRepository, type ViewRow } from './views.repository.js';

import type { ViewVisibility } from '../platform-kernel/db/tables/tags-views.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * `GET /views` and `GET /views/{id}` (contracts/tickets.yaml, T141): views visible to the caller
 * (FR-076, FR-077), with a live ticket count each (research D13). Needs Triage is additionally
 * hidden from viewers without Ungrouped view access (data-model.md "views"); an unknown or
 * invisible view is 404 `VIEW_NOT_FOUND`, same as any other invisible resource (constitution I).
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

const NEEDS_TRIAGE_SYSTEM_KEY = 'needs_triage';

function viewerIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('Views are listed for user actors');
  return ctx.actor.id;
}

/** FR-077: Needs Triage only for viewers with view access to Ungrouped (`groupId = null`). */
function hasUngroupedView(access: EffectiveAccess): boolean {
  return access.groups.get(null)?.view === true;
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
    private readonly viewCompiler: ViewCompiler,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext): Promise<ViewDto[]> {
    const viewerId = viewerIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const access = await this.policy.effectiveAccess(ctx, viewerId);
      const rows = await new ViewsRepository(ctx).listAll(tx);
      const visible: ViewRow[] = [];
      for (const row of rows) {
        if (!(await this.canSee(ctx, tx, row, viewerId, access))) continue;
        visible.push(row);
      }
      const now = this.clock.now();
      const counts = await Promise.all(visible.map((row) => this.countFor(ctx, tx, row, now)));
      return visible.map((row, index) => toViewDto(row, viewerId, access, counts[index]!));
    });
  }

  async get(ctx: TenantContext, id: string): Promise<ViewDto> {
    const viewerId = viewerIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await new ViewsRepository(ctx).byId(tx, id);
      if (row === undefined) throw notFound('view');
      const access = await this.policy.effectiveAccess(ctx, viewerId);
      if (!(await this.canSee(ctx, tx, row, viewerId, access))) throw notFound('view');
      const count = await this.countFor(ctx, tx, row, this.clock.now());
      return toViewDto(row, viewerId, access, count);
    });
  }

  private async canSee(ctx: TenantContext, tx: TenantTransaction, row: ViewRow, viewerId: string, access: EffectiveAccess): Promise<boolean> {
    if (row.systemKey === NEEDS_TRIAGE_SYSTEM_KEY && !hasUngroupedView(access)) return false;
    return new ViewVisibilityRepository(ctx).canSee(tx, row, viewerId, access);
  }

  private async countFor(ctx: TenantContext, tx: TenantTransaction, row: ViewRow, now: Date): Promise<number> {
    const filter = await this.viewCompiler.filterFor(ctx, row.conditions, now);
    return new TicketCountRepository(ctx).count(tx, filter);
  }
}
