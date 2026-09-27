import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { PolicyService } from '../authorization/policy.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';

import { ViewCompiler } from './view-compiler.js';
import { viewerIdOf, visibleViews } from './view-visibility.js';
import { TicketCountRepository, type ViewRow } from './views.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * View counts (research D13, T159): `COUNT(*)` over a view's own query for one viewer (tenant
 * filter AND the viewer's access filter AND the compiled conditions), cached per (viewer, view)
 * for 30 s in one Redis hash per viewer. When a ticket in a group they can view changes, the counts
 * notifier (counts-notifier.ts) drops the viewer's hash and tells their sockets to refetch.
 *
 * The hash also stores the access version its counts were computed under, so after an access
 * change the hash no longer matches and nobody has to find and delete it. Relative conditions
 * (`within_last`, `pending_until before now`) drift without any event; the 30 s TTL bounds that.
 * A Redis failure only costs the cache: counts are computed from the database.
 */

export const VIEW_COUNTS_TTL_S = 30;
const VERSION_FIELD = '_v';

export function viewCountsKey(tenantId: string, userId: string): string {
  return `t:${tenantId}:view-counts:${userId}`;
}

export type ViewCounts = Record<string, number>;

@Injectable()
export class ViewCountsService {
  private readonly logger = new Logger('ViewCountsService');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly viewCompiler: ViewCompiler,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** `GET /views/counts`: the count of every view the caller sees, by view id. */
  counts(ctx: TenantContext): Promise<ViewCounts> {
    const viewerId = viewerIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const access = await this.policy.effectiveAccess(ctx, viewerId);
      const views = await visibleViews(ctx, tx, viewerId, access);
      return this.countsFor(ctx, tx, access.accessVersion, views);
    });
  }

  /** Counts for views already checked as visible to `ctx`'s viewer: cached ones where fresh. */
  async countsFor(ctx: TenantContext, tx: TenantTransaction, accessVersion: string, views: readonly ViewRow[]): Promise<ViewCounts> {
    const key = viewCountsKey(ctx.tenantId, viewerIdOf(ctx));
    const cached = await this.read(key, accessVersion);
    const counts: ViewCounts = {};
    const missing: ViewRow[] = [];
    for (const view of views) {
      const hit = cached?.get(view.id);
      if (hit === undefined) missing.push(view);
      else counts[view.id] = hit;
    }
    if (missing.length === 0) return counts;

    const now = this.clock.now();
    const fresh: ViewCounts = {};
    for (const view of missing) {
      const filter = await this.viewCompiler.filterFor(ctx, view.conditions, now);
      fresh[view.id] = await new TicketCountRepository(ctx).count(tx, filter);
    }
    await this.write(key, accessVersion, fresh, cached === undefined);
    return { ...counts, ...fresh };
  }

  /** Drops the viewers' cached counts; the next read recomputes them. */
  async invalidate(tenantId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.redis.del(...userIds.map((userId) => viewCountsKey(tenantId, userId)));
    } catch (error) {
      this.logger.warn(`View count invalidation failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async read(key: string, accessVersion: string): Promise<Map<string, number> | undefined> {
    try {
      const hash = await this.redis.hgetall(key);
      if (hash[VERSION_FIELD] !== accessVersion) return undefined;
      return new Map(
        Object.entries(hash)
          .filter(([field]) => field !== VERSION_FIELD)
          .map(([field, value]) => [field, Number(value)]),
      );
    } catch {
      return undefined;
    }
  }

  /** A new hash (none, or one from another access version) starts the 30 s; filling in keeps it. */
  private async write(key: string, accessVersion: string, counts: ViewCounts, replace: boolean): Promise<void> {
    try {
      if (!replace) {
        // `NX`: keep the running TTL, but never leave a key without one (it may have just been
        // invalidated, and then it has no version and reads as a miss anyway).
        await this.redis.multi().hset(key, counts).expire(key, VIEW_COUNTS_TTL_S, 'NX').exec();
        return;
      }
      await this.redis
        .multi()
        .del(key)
        .hset(key, { ...counts, [VERSION_FIELD]: accessVersion })
        .expire(key, VIEW_COUNTS_TTL_S)
        .exec();
    } catch (error) {
      this.logger.warn(`View count cache write failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}
