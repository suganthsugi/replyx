import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError } from '../platform-kernel/http/app-error.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Account lockout (research D5): 5 failed password attempts within 15 minutes lock the account
 * for 15 minutes. A successful sign-in resets the count. Locking writes an `auth.locked` audit
 * entry in the caller's transaction.
 *
 * The sliding window lives in Redis (a sorted set of failure times per user, tenant in the key);
 * the lock itself (`users.locked_until`) and the current count (`users.failed_sign_ins`) are in
 * the database. If Redis is unavailable the count falls back to consecutive failures in the
 * database, so lockout still engages.
 */

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_DURATION_MS = 15 * 60_000;

export type FailureResult = { locked: false; failures: number } | { locked: true; lockedUntil: Date };

export function accountLocked(): AppError {
  return new AppError('ACCOUNT_LOCKED', 423, 'Too many failed sign-in attempts. Try again in 15 minutes');
}

function windowKey(tenantId: string, userId: string): string {
  return `lockout:${tenantId}:${userId}`;
}

@Injectable()
export class LockoutService {
  private readonly logger = new Logger('LockoutService');

  constructor(
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  isLocked(user: { locked_until: Date | null }): boolean {
    return user.locked_until !== null && user.locked_until.getTime() > this.clock.nowMs();
  }

  /**
   * Call after a wrong password for an existing user, inside the sign-in transaction. Sign-in
   * checks `isLocked` first and answers `accountLocked()` without verifying the password.
   */
  async recordFailure(tx: TenantTransaction, userId: string): Promise<FailureResult> {
    const ctx = requireScope(tx);
    const repo = new LockoutRepository(ctx);
    const now = this.clock.nowMs();

    // A failure during an active lock neither counts nor extends the lock.
    const current = await repo.lockedUntil(tx, userId);
    if (current !== null && current.getTime() > now) return { locked: true, lockedUntil: current };

    const windowed = await this.countInWindow(ctx.tenantId, userId, now);
    const failures = windowed ?? (await repo.incrementFailures(tx, userId));

    if (failures < LOCKOUT_MAX_FAILURES) {
      if (windowed !== undefined) await repo.setFailures(tx, userId, failures);
      return { locked: false, failures };
    }

    const lockedUntil = new Date(now + LOCKOUT_DURATION_MS);
    // Only the request that actually sets the lock writes the audit entry.
    const lockedNow = await repo.lock(tx, userId, failures, lockedUntil, new Date(now));
    if (lockedNow) {
      // Actor, IP and request id come from the sign-in transaction's context.
      await this.audit.record(tx, {
        action: 'auth.locked',
        resourceType: 'user',
        resourceId: userId,
        details: { failedAttempts: failures, lockedUntil: lockedUntil.toISOString() },
      });
    }
    await this.clearWindow(ctx.tenantId, userId);
    return { locked: true, lockedUntil };
  }

  /** Call after a successful sign-in: the count and any expired lock are cleared. */
  async recordSuccess(tx: TenantTransaction, userId: string): Promise<void> {
    const ctx = requireScope(tx);
    await new LockoutRepository(ctx).reset(tx, userId);
    await this.clearWindow(ctx.tenantId, userId);
  }

  /** Failures in the last 15 minutes including this one, or undefined when Redis is down. */
  private async countInWindow(tenantId: string, userId: string, now: number): Promise<number | undefined> {
    const key = windowKey(tenantId, userId);
    try {
      const results = await this.redis
        .multi()
        .zadd(key, now, `${now}:${randomBytes(4).toString('hex')}`)
        .zremrangebyscore(key, '-inf', now - LOCKOUT_WINDOW_MS)
        .zcard(key)
        .pexpire(key, LOCKOUT_WINDOW_MS)
        .exec();
      const [error, count] = results?.[2] ?? [new Error('no result')];
      if (error !== null || typeof count !== 'number') throw error ?? new Error('bad result');
      return count;
    } catch (error) {
      this.logger.warn(`Lockout window unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
      return undefined;
    }
  }

  private async clearWindow(tenantId: string, userId: string): Promise<void> {
    try {
      await this.redis.del(windowKey(tenantId, userId));
    } catch {
      // Expires on its own after 15 minutes.
    }
  }
}

class LockoutRepository extends TenantRepository {
  async lockedUntil(tx: TenantTransaction, userId: string): Promise<Date | null> {
    const row = await this.selectFrom(tx, 'users').select('locked_until').where('id', '=', userId).executeTakeFirst();
    return row?.locked_until ?? null;
  }

  async incrementFailures(tx: TenantTransaction, userId: string): Promise<number> {
    const row = await this.updateTable(tx, 'users')
      .set((eb) => ({ failed_sign_ins: eb('failed_sign_ins', '+', 1) }))
      .where('id', '=', userId)
      .returning('failed_sign_ins')
      .executeTakeFirst();
    return row?.failed_sign_ins ?? 0;
  }

  async setFailures(tx: TenantTransaction, userId: string, failures: number): Promise<void> {
    await this.updateTable(tx, 'users').set({ failed_sign_ins: failures }).where('id', '=', userId).execute();
  }

  /** Sets the lock unless one is already active; true when this call set it. */
  async lock(tx: TenantTransaction, userId: string, failures: number, lockedUntil: Date, now: Date): Promise<boolean> {
    const row = await this.updateTable(tx, 'users')
      .set({ failed_sign_ins: failures, locked_until: lockedUntil })
      .where('id', '=', userId)
      .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async reset(tx: TenantTransaction, userId: string): Promise<void> {
    await this.updateTable(tx, 'users')
      .set({ failed_sign_ins: 0, locked_until: null })
      .where('id', '=', userId)
      .where((eb) => eb.or([eb('failed_sign_ins', '>', 0), eb('locked_until', 'is not', null)]))
      .execute();
  }
}

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('LockoutService must run inside withTenant');
  return ctx;
}
