import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PasswordService } from '../../identity/password.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { AppError } from '../../platform-kernel/http/app-error.js';
import { appendSetCookie, serializeCookie } from '../../platform-kernel/http/cookies.js';
import { REDIS } from '../../platform-kernel/redis/redis.module.js';

import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';

/**
 * Platform-operator sessions (FR-001, contracts/platform.yaml `operatorSession`). Operators
 * belong to no tenant, so everything here lives in the global tables through `PLATFORM_DB`:
 * `platform_operators` and `operator_sessions`, never a `TenantRepository`.
 *
 * The cookie is `rx_op_session`, host-only on the console host, and only the SHA-256 hash of the
 * token is stored — the same rule as tenant sessions (research D5).
 */

export const OPERATOR_SESSION_COOKIE = 'rx_op_session';

/** Operators are staff of the platform: the shorter staff-like idle window applies. */
export const OPERATOR_IDLE_MS = 12 * 60 * 60_000;

/** Failed operator sign-ins are counted in Redis: `platform_operators` has no lockout columns. */
export const OPERATOR_LOCKOUT_MAX_FAILURES = 5;
export const OPERATOR_LOCKOUT_WINDOW_MS = 15 * 60_000;
export const OPERATOR_LOCKOUT_DURATION_MS = 15 * 60_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,255}$/;

export interface OperatorPrincipal {
  sessionId: string;
  operatorId: string;
  email: string;
  name: string;
  expiresAt: number;
}

export function operatorAccountLocked(): AppError {
  return new AppError('ACCOUNT_LOCKED', 423, 'Too many failed sign-in attempts. Try again in 15 minutes');
}

export function invalidOperatorCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 401, 'Wrong email or password');
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function lockKey(email: string): string {
  return `operator-lockout:${email}`;
}

@Injectable()
export class OperatorSessionService {
  private readonly logger = new Logger('OperatorSessionService');

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    private readonly passwords: PasswordService,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Verifies the credentials and opens a session. The same 401 answers an unknown email and a
   * wrong password, and a deactivated operator; only a locked account differs (423), because the
   * caller has to be told why waiting helps.
   */
  async signIn(email: string, password: string, client: { ip: string | null; userAgent: string | null }) {
    if (await this.isLocked(email)) throw operatorAccountLocked();

    const operator = await this.db
      .selectFrom('platform_operators')
      .select(['id', 'email', 'name', 'password_hash', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();

    // Always verify something, so an unknown email costs the same time as a wrong password.
    const ok = await this.passwords.verify(operator?.password_hash ?? null, password);
    if (!ok || operator === undefined || operator.status !== 'active') {
      await this.recordFailure(email);
      throw invalidOperatorCredentials();
    }
    await this.clearFailures(email);

    const token = randomBytes(32).toString('base64url');
    const now = this.clock.nowMs();
    const expiresAt = now + OPERATOR_IDLE_MS;
    const row = await this.db
      .insertInto('operator_sessions')
      .values({
        operator_id: operator.id,
        token_hash: hashToken(token),
        last_seen_at: new Date(now),
        expires_at: new Date(expiresAt),
        ip: client.ip,
        user_agent: client.userAgent?.slice(0, 500) ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.db
      .updateTable('platform_operators')
      .set({ last_sign_in_at: new Date(now) })
      .where('id', '=', operator.id)
      .execute();

    // Housekeeping on the rare path rather than a sweeper: the table only grows on sign-in.
    await this.purgeExpired().catch((error: unknown) => {
      this.logger.warn(`Expired operator sessions not purged: ${error instanceof Error ? error.message : 'unknown'}`);
    });

    const principal: OperatorPrincipal = {
      sessionId: row.id,
      operatorId: operator.id,
      email: operator.email,
      name: operator.name,
      expiresAt,
    };
    return { token, principal };
  }

  /** The session for `token`, or undefined when it is unknown, expired or deactivated. */
  async authenticate(token: string | undefined): Promise<OperatorPrincipal | undefined> {
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const now = this.clock.nowMs();
    const row = await this.db
      .selectFrom('operator_sessions')
      .innerJoin('platform_operators', 'platform_operators.id', 'operator_sessions.operator_id')
      .select([
        'operator_sessions.id',
        'operator_sessions.operator_id',
        'operator_sessions.expires_at',
        'operator_sessions.last_seen_at',
        'platform_operators.email',
        'platform_operators.name',
        'platform_operators.status',
      ])
      .where('operator_sessions.token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (row === undefined || row.status !== 'active' || row.expires_at.getTime() <= now) return undefined;

    // Use slides the idle expiry, at most once a minute.
    let expiresAt = row.expires_at.getTime();
    if (now - row.last_seen_at.getTime() >= 60_000) {
      expiresAt = now + OPERATOR_IDLE_MS;
      await this.db
        .updateTable('operator_sessions')
        .set({ last_seen_at: new Date(now), expires_at: new Date(expiresAt) })
        .where('id', '=', row.id)
        .execute();
    }
    return { sessionId: row.id, operatorId: row.operator_id, email: row.email, name: row.name, expiresAt };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.deleteFrom('operator_sessions').where('id', '=', sessionId).execute();
  }

  /** Deletes sessions that idled out; called by the operator sign-in path to keep the table small. */
  async purgeExpired(): Promise<void> {
    await this.db.deleteFrom('operator_sessions').where('expires_at', '<=', this.clock.now()).execute();
  }

  setCookie(res: Parameters<typeof appendSetCookie>[0], token: string): void {
    appendSetCookie(res, serializeCookie(OPERATOR_SESSION_COOKIE, token, { httpOnly: true }));
  }

  clearCookie(res: Parameters<typeof appendSetCookie>[0]): void {
    appendSetCookie(res, serializeCookie(OPERATOR_SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }));
  }

  private async isLocked(email: string): Promise<boolean> {
    try {
      const value = await this.redis.get(lockKey(email));
      return value !== null && Number(value) >= OPERATOR_LOCKOUT_MAX_FAILURES;
    } catch (error) {
      // Redis down: do not lock everyone out of the console.
      this.logger.warn(`Operator lockout check failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    }
  }

  private async recordFailure(email: string): Promise<void> {
    try {
      const key = lockKey(email);
      const failures = await this.redis.incr(key);
      // The window starts at the first failure; reaching the limit extends it into the lock.
      const ttlMs = failures >= OPERATOR_LOCKOUT_MAX_FAILURES ? OPERATOR_LOCKOUT_DURATION_MS : OPERATOR_LOCKOUT_WINDOW_MS;
      await this.redis.pexpire(key, ttlMs);
    } catch (error) {
      this.logger.warn(`Operator lockout counter failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async clearFailures(email: string): Promise<void> {
    try {
      await this.redis.del(lockKey(email));
    } catch {
      // Nothing to do: the counter expires on its own.
    }
  }
}
