import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { appendSetCookie, serializeCookie, SESSION_COOKIE } from '../platform-kernel/http/cookies.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { REDIS } from '../platform-kernel/redis/redis.module.js';

import { SessionRepository } from './session.repository.js';

import type { DomainEventPayload } from '../platform-kernel/outbox/event-types.js';

/**
 * Server-side sessions (research D5). The browser holds a random 256-bit token in the host-only
 * `rx_session` cookie; the database stores only its SHA-256 hash. Lookups go through a 60 s
 * Redis cache that revocation purges. Expiry is idle-based and slides on use.
 */

export type SessionKind = 'staff' | 'customer';

export interface SessionPrincipal {
  sessionId: string;
  tenantId: string;
  userId: string;
  kind: SessionKind;
  trustedDevice: boolean;
  expiresAt: number;
}

export interface CreateSessionInput {
  userId: string;
  kind: SessionKind;
  /** Customers: "keep me signed in" (on by default in the chat). Ignored for staff. */
  trustedDevice?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}

export type RevokeReason = DomainEventPayload<'session.revoked'>['reason'];

const HOUR_MS = 3_600_000;
export const STAFF_IDLE_MS = 12 * HOUR_MS;
export const CUSTOMER_TRUSTED_IDLE_MS = 30 * 24 * HOUR_MS;
/** A customer who did not choose "keep me signed in" gets the staff idle window. */
export const CUSTOMER_IDLE_MS = 12 * HOUR_MS;
const CACHE_TTL_S = 60;
/** Sliding expiry is written back at most this often per session. */
const TOUCH_INTERVAL_MS = 5 * 60_000;
const USER_AGENT_MAX = 512;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function idleWindowMs(kind: SessionKind, trustedDevice: boolean): number {
  if (kind === 'staff') return STAFF_IDLE_MS;
  return trustedDevice ? CUSTOMER_TRUSTED_IDLE_MS : CUSTOMER_IDLE_MS;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function cacheKey(tenantId: string, tokenHash: Buffer): string {
  return `session:${tenantId}:${tokenHash.toString('hex')}`;
}

/** Maps a session id to its cache key so revocation by id can purge it. */
function cacheIndexKey(tenantId: string, sessionId: string): string {
  return `session-key:${tenantId}:${sessionId}`;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger('SessionService');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Creates a session in the caller's transaction and returns the raw token (shown once). */
  async create(tx: TenantTransaction, input: CreateSessionInput): Promise<{ token: string; principal: SessionPrincipal }> {
    const ctx = requireScope(tx);
    const token = randomBytes(32).toString('base64url');
    const trustedDevice = input.kind === 'customer' && (input.trustedDevice ?? true);
    const now = this.clock.nowMs();
    const expiresAt = now + idleWindowMs(input.kind, trustedDevice);
    const sessionId = await new SessionRepository(ctx).insert(tx, {
      userId: input.userId,
      tokenHash: hashToken(token),
      kind: input.kind,
      trustedDevice,
      lastSeenAt: new Date(now),
      expiresAt: new Date(expiresAt),
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    });
    return {
      token,
      principal: { sessionId, tenantId: ctx.tenantId, userId: input.userId, kind: input.kind, trustedDevice, expiresAt },
    };
  }

  /**
   * The session for `token` in this tenant, or undefined when it is unknown, expired, belongs to
   * another tenant (RLS: it is simply not found) or its user is no longer active.
   *
   * Use counts as activity and slides the idle expiry, unless `slide` is false (background
   * checks such as the socket expiry sweep, which must not keep an idle session alive).
   */
  async authenticate(
    tenantId: string,
    token: string | undefined,
    options: { slide?: boolean } = {},
  ): Promise<SessionPrincipal | undefined> {
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const tokenHash = hashToken(token);
    const now = this.clock.nowMs();

    const cached = await this.readCache(tenantId, tokenHash);
    if (cached !== undefined) {
      return cached.expiresAt > now ? cached : undefined;
    }

    const ctx = systemContext(tenantId, 'session-lookup');
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) =>
      new SessionRepository(ctx).findByTokenHash(tx, tokenHash),
    );
    if (row === undefined || row.user_status !== 'active' || row.user_kind !== row.kind) return undefined;
    if (row.expires_at.getTime() <= now) return undefined;

    let expiresAt = row.expires_at.getTime();
    if (options.slide !== false && now - row.last_seen_at.getTime() >= TOUCH_INTERVAL_MS) {
      expiresAt = now + idleWindowMs(row.kind, row.trusted_device);
      await this.touch(tenantId, row.id, now, expiresAt);
    }
    const principal: SessionPrincipal = {
      sessionId: row.id,
      tenantId,
      userId: row.user_id,
      kind: row.kind,
      trustedDevice: row.trusted_device,
      expiresAt,
    };
    await this.writeCache(tokenHash, principal, now);
    return principal;
  }

  /** Deletes one session, purges its cache entry and emits `session.revoked`. */
  async revoke(tx: TenantTransaction, sessionId: string, reason: RevokeReason): Promise<boolean> {
    const row = (await new SessionRepository(requireScope(tx)).deleteById(tx, sessionId))[0];
    if (row === undefined) return false;
    await this.announce(tx, row.user_id, [row.id], reason);
    return true;
  }

  /** Sign out everywhere, deactivation, deletion, suspension. Returns the revoked session ids. */
  async revokeAllForUser(tx: TenantTransaction, userId: string, reason: RevokeReason): Promise<string[]> {
    const rows = await new SessionRepository(requireScope(tx)).deleteAllForUser(tx, userId);
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) await this.announce(tx, userId, ids, reason);
    return ids;
  }

  /**
   * Drops cached lookups. Called during revocation and again when `session.revoked` is published
   * (after commit), so a lookup racing the revoking transaction can't keep a session alive.
   */
  async purgeCache(tenantId: string, sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const indexKeys = sessionIds.map((id) => cacheIndexKey(tenantId, id));
    try {
      const keys = (await this.redis.mget(...indexKeys)).filter((key): key is string => key !== null);
      await this.redis.del(...indexKeys, ...keys);
    } catch (error) {
      this.logger.warn(`Session cache purge failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  setCookie(res: Parameters<typeof appendSetCookie>[0], token: string, principal: SessionPrincipal): void {
    // Trusted customer devices keep the cookie across browser restarts; everything else is a
    // browser-session cookie backed by the server-side idle expiry.
    const maxAge = principal.kind === 'customer' && principal.trustedDevice ? CUSTOMER_TRUSTED_IDLE_MS / 1000 : undefined;
    appendSetCookie(res, serializeCookie(SESSION_COOKIE, token, { httpOnly: true, maxAge }));
  }

  clearCookie(res: Parameters<typeof appendSetCookie>[0]): void {
    appendSetCookie(res, serializeCookie(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }));
  }

  private async announce(tx: TenantTransaction, userId: string, sessionIds: string[], reason: RevokeReason) {
    const ctx = requireScope(tx);
    await this.outbox.append(tx, {
      type: 'session.revoked',
      payload: { userId, sessionIds, reason },
      streams: [`user:${userId}`],
    });
    await this.purgeCache(ctx.tenantId, sessionIds);
  }

  private async touch(tenantId: string, sessionId: string, now: number, expiresAt: number): Promise<void> {
    const ctx = systemContext(tenantId, 'session-touch');
    await this.unitOfWork.withTenant(ctx, (tx) =>
      new SessionRepository(ctx).touch(tx, sessionId, new Date(now), new Date(expiresAt)),
    );
  }

  private async readCache(tenantId: string, tokenHash: Buffer): Promise<SessionPrincipal | undefined> {
    try {
      const raw = await this.redis.get(cacheKey(tenantId, tokenHash));
      if (raw === null) return undefined;
      const principal = JSON.parse(raw) as SessionPrincipal;
      return principal.tenantId === tenantId ? principal : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(tokenHash: Buffer, principal: SessionPrincipal, now: number): Promise<void> {
    const ttl = Math.min(CACHE_TTL_S, Math.floor((principal.expiresAt - now) / 1000));
    if (ttl <= 0) return;
    const key = cacheKey(principal.tenantId, tokenHash);
    try {
      await this.redis
        .multi()
        .set(key, JSON.stringify(principal), 'EX', ttl)
        .set(cacheIndexKey(principal.tenantId, principal.sessionId), key, 'EX', ttl)
        .exec();
    } catch {
      // The cache is an optimization; the database stays authoritative.
    }
  }
}

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('SessionService must run inside withTenant');
  return ctx;
}

function systemContext(tenantId: string, requestId: string): TenantContext {
  return TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId });
}
