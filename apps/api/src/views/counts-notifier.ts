import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AccessRepository, PolicyService } from '../authorization/policy.service.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';

import { ViewCompiler } from './view-compiler.js';
import { ViewCountsService } from './view-counts.service.js';
import { visibleViews } from './view-visibility.js';

import type { DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * `views.counts_changed` hints (research D13, contracts/realtime-events.md, T159).
 *
 * A ticket list event (`ticket.created`, `ticket.updated`, `ticket.removed_from_view`) names the
 * `tickets:group:*` streams it went to: the ticket's group, and its old one after a move. Every
 * active staff user with view on one of those groups may see a different count now, so their
 * cached counts are dropped at once and each gets a hint on their `views` stream. `access.changed`
 * can change anyone's counts, so it reaches every active staff user.
 *
 * The consumer runs after the change has committed (it consumes a published event), so a refetch
 * can't cache the old counts again. Hints are throttled per viewer to one per 500 ms window:
 *
 * - the first change in a window (a Redis `SET NX PX 500` per viewer, shared by every worker)
 *   appends its hint in the consumer's own transaction, so it is as durable as the event itself
 *   and `sync` replays it after a reconnect;
 * - changes later in the window only schedule one trailing hint in this process, sent when the
 *   window ends. That one is lost if the process crashes first (a graceful stop sends it); the web
 *   client refetches counts every 60 s as the backstop for exactly that case.
 */

const WINDOW_MS = 500;

function windowKey(tenantId: string, userId: string): string {
  return `t:${tenantId}:view-counts-hint:${userId}`;
}

@Injectable()
export class CountsNotifier implements OnApplicationShutdown {
  private readonly logger = new Logger('CountsNotifier');
  private readonly trailing = new Map<string, { tenantId: string; userId: string; timer: NodeJS.Timeout }>();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly viewCounts: ViewCountsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Drops the viewers' cached counts now; hints them in `tx` or at the end of their window. */
  async changed(ctx: TenantContext, tx: TenantTransaction, userIds: readonly string[]): Promise<void> {
    await this.viewCounts.invalidate(ctx.tenantId, userIds);
    for (const userId of userIds) {
      if (await this.opensWindow(ctx.tenantId, userId)) await this.appendHint(ctx, tx, userId);
      else this.scheduleTrailing(ctx.tenantId, userId);
    }
  }

  /** True for the first change in the viewer's window. Without Redis every change hints. */
  private async opensWindow(tenantId: string, userId: string): Promise<boolean> {
    try {
      return (await this.redis.set(windowKey(tenantId, userId), '1', 'PX', WINDOW_MS, 'NX')) === 'OK';
    } catch {
      return true;
    }
  }

  private scheduleTrailing(tenantId: string, userId: string): void {
    const key = `${tenantId}:${userId}`;
    if (this.trailing.has(key)) return;
    const timer = setTimeout(() => {
      this.trailing.delete(key);
      void this.flush(tenantId, userId);
    }, WINDOW_MS);
    this.trailing.set(key, { tenantId, userId, timer });
  }

  /** The hint names every view the user sees now (the client refetches all counts anyway). */
  private async appendHint(ctx: TenantContext, tx: TenantTransaction, userId: string): Promise<void> {
    const access = await this.policy.effectiveAccess(ctx, userId);
    const views = await visibleViews(ctx, tx, userId, access);
    if (views.length === 0) return;
    await this.outbox.append(tx, {
      type: 'views.counts_changed',
      actor: { kind: 'system' },
      payload: { viewIds: views.map((view) => view.id) },
      streams: [`views:${userId}`],
    });
  }

  /** A trailing hint, in its own transaction. */
  async flush(tenantId: string, userId: string): Promise<void> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `view-counts:${userId}` });
    try {
      await this.unitOfWork.withTenant(ctx, (tx) => this.appendHint(ctx, tx, userId));
    } catch (error) {
      this.logger.warn(`View count hint failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const pending = [...this.trailing.values()];
    this.trailing.clear();
    for (const entry of pending) clearTimeout(entry.timer);
    await Promise.all(pending.map((entry) => this.flush(entry.tenantId, entry.userId)));
  }
}

type Handled = Extract<DomainEventType, 'ticket.created' | 'ticket.updated' | 'ticket.removed_from_view' | 'access.changed'>;

const GROUP_STREAM_PREFIX = 'tickets:group:';

/** The groups (`null` = Ungrouped) whose list rooms an event went to. */
export function groupsOfStreams(streams: readonly string[]): (string | null)[] {
  const groups = new Set<string | null>();
  for (const stream of streams) {
    if (!stream.startsWith(GROUP_STREAM_PREFIX)) continue;
    const id = stream.slice(GROUP_STREAM_PREFIX.length);
    groups.add(id === 'ungrouped' ? null : id);
  }
  return [...groups];
}

@Injectable()
export class ViewCountsConsumer extends IdempotentHandler<Handled> {
  readonly consumer = 'view-counts';
  readonly queue = 'notifications' as const;
  readonly eventTypes: readonly Handled[] = ['ticket.created', 'ticket.updated', 'ticket.removed_from_view', 'access.changed'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly notifier: CountsNotifier,
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('ViewCountsConsumer.handle must run inside withTenant');

    let viewers: string[];
    if (event.type === 'access.changed') {
      viewers = await new ActiveStaffRepository(ctx).ids(tx);
    } else {
      const access = new AccessRepository(ctx);
      const ids = new Set<string>();
      for (const groupId of groupsOfStreams(event.streams)) {
        for (const id of await access.groupViewerIds(tx, groupId)) ids.add(id);
      }
      viewers = [...ids];
    }
    await this.notifier.changed(ctx, tx, viewers);
  }
}

class ActiveStaffRepository extends TenantRepository {
  async ids(tx: TenantTransaction): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .execute();
    return rows.map((row) => row.id);
  }
}

/** Worker only: the consumer and its debouncer (jobs.module.ts discovers the consumer). */
@Module({ providers: [ViewCountsService, ViewCompiler, CountsNotifier, ViewCountsConsumer] })
export class ViewsJobsModule {}
