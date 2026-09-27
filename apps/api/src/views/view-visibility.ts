import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import { ViewsRepository, type ViewRow } from './views.repository.js';

import type { EffectiveAccess } from '../authorization/policy.service.js';
import type { ViewVisibility } from '../platform-kernel/db/tables/tags-views.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Whether a view is visible to a viewer (data-model.md "views", FR-076, FR-077): `all_staff` to
 * every staff user; `personal` only to its owner; `roles`/`groups` when the viewer holds one of
 * the shared roles or groups. An invisible view is 404, the same as a missing one (constitution
 * I) — callers throw that themselves; this only answers the yes/no question.
 *
 * Shared by every view read: `GET /tickets?viewId=` (T135), and `GET /views`, `GET /views/{id}`
 * (T141).
 */
export interface ViewAccessRow {
  visibility: ViewVisibility;
  ownerId: string | null;
  sharedRoleIds: readonly string[];
  sharedGroupIds: readonly string[];
}

export class ViewVisibilityRepository extends TenantRepository {
  async canSee(tx: TenantTransaction, view: ViewAccessRow, viewerId: string, access: EffectiveAccess): Promise<boolean> {
    switch (view.visibility) {
      case 'all_staff':
        return true;
      case 'personal':
        return view.ownerId === viewerId;
      case 'roles': {
        if (view.sharedRoleIds.length === 0) return false;
        const rows = await this.selectFrom(tx, 'user_roles').select('user_roles.role_id').where('user_roles.user_id', '=', viewerId).execute();
        const owned = new Set(rows.map((row) => row.role_id));
        return view.sharedRoleIds.some((id) => owned.has(id));
      }
      case 'groups':
        return view.sharedGroupIds.some((id) => access.groups.has(id));
    }
  }
}

const NEEDS_TRIAGE_SYSTEM_KEY = 'needs_triage';

/** FR-077: Needs Triage only for viewers with view access to Ungrouped (`groupId = null`). */
function hasUngroupedView(access: EffectiveAccess): boolean {
  return access.groups.get(null)?.view === true;
}

/**
 * Whether `viewerId` sees the view: its sharing rules, and Needs Triage additionally only with
 * Ungrouped view access (data-model.md "views").
 */
export function canSeeView(ctx: TenantContext, tx: TenantTransaction, view: ViewAccessRow & { systemKey: string | null }, viewerId: string, access: EffectiveAccess): Promise<boolean> {
  if (view.systemKey === NEEDS_TRIAGE_SYSTEM_KEY && !hasUngroupedView(access)) return Promise.resolve(false);
  return new ViewVisibilityRepository(ctx).canSee(tx, view, viewerId, access);
}

/** The views `viewerId` sees, in display order (`GET /views`, `GET /views/counts`). */
export async function visibleViews(ctx: TenantContext, tx: TenantTransaction, viewerId: string, access: EffectiveAccess): Promise<ViewRow[]> {
  const visible: ViewRow[] = [];
  for (const row of await new ViewsRepository(ctx).listAll(tx)) {
    if (await canSeeView(ctx, tx, row, viewerId, access)) visible.push(row);
  }
  return visible;
}

/** Views are listed and counted for user actors only. */
export function viewerIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('Views are listed for user actors');
  return ctx.actor.id;
}
