import { createHash, randomBytes } from 'node:crypto';

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Redis } from 'ioredis';

import { Clock } from '../clock.js';
import { REDIS } from '../redis/redis.module.js';

import { rateLimited } from './app-error.js';

import type { Request } from 'express';

/**
 * Redis sliding-window rate limits (research D19). Each policy counts requests per subject in
 * the last `windowMs`; the request that would exceed `limit` gets 429 `RATE_LIMITED` with a
 * `Retry-After` header and `error.retryAfter` (set by the error filter from the AppError).
 *
 * Routes opt in with `@RateLimit('sign-in')`; the `api` policy applies to every request that has
 * a session. Services that are not HTTP routes (socket messages) call `RateLimiter.consume`.
 * When Redis is unavailable requests are allowed (logged): limits protect capacity, and the
 * lockout (identity/lockout.service.ts) still guards passwords.
 */

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

const MINUTE_MS = 60_000;

export const RATE_LIMIT_POLICIES = {
  /** Per client IP. */
  'sign-in': { limit: 10, windowMs: MINUTE_MS },
  /** Per email address (customer sign-in links, password reset). */
  'sign-in-link': { limit: 5, windowMs: 60 * MINUTE_MS },
  /** Per customer. */
  'customer-message': { limit: 20, windowMs: MINUTE_MS },
  /** Per session. */
  api: { limit: 600, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

// Atomic: drop expired entries, then either reject with the time until the oldest one leaves
// the window, or record this request.
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return tonumber(oldest[2]) + window - now
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return 0
`;

/** Subjects are hashed so keys never contain emails or IPs. Tenant `-` = console host. */
export function rateLimitKey(policy: RateLimitPolicyName, tenantId: string | undefined, subject: string): string {
  const digest = createHash('sha256').update(subject, 'utf8').digest('base64url').slice(0, 22);
  return `rl:${policy}:${tenantId ?? '-'}:${digest}`;
}

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger('RateLimiter');

  constructor(
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Counts one request; throws 429 `RATE_LIMITED` when the policy's limit is reached. */
  async consume(policy: RateLimitPolicyName, tenantId: string | undefined, subject: string): Promise<void> {
    const { limit, windowMs } = RATE_LIMIT_POLICIES[policy];
    const now = this.clock.nowMs();
    let waitMs: number;
    try {
      const result = await this.redis.eval(
        SLIDING_WINDOW,
        1,
        rateLimitKey(policy, tenantId, subject),
        now,
        windowMs,
        limit,
        `${now}:${randomBytes(6).toString('hex')}`,
      );
      waitMs = Number(result);
    } catch (error) {
      this.logger.warn(`Rate limit ${policy} skipped: ${error instanceof Error ? error.message : 'unknown'}`);
      return;
    }
    if (waitMs > 0) throw rateLimited(waitMs / 1000);
  }
}

// ---------------------------------------------------------------------------------------------
// Route decorator and guard
// ---------------------------------------------------------------------------------------------

const RATE_LIMIT = 'replyx:rateLimit';

/** Applies a named policy to a route, in addition to the per-session `api` policy. */
export const RateLimit = (policy: Exclude<RateLimitPolicyName, 'api'>) => SetMetadata(RATE_LIMIT, policy);

/** Which subject a route policy counts, taken from the request. */
export function rateLimitSubject(policy: RateLimitPolicyName, req: Request): string {
  switch (policy) {
    case 'sign-in':
      return req.ip ?? 'unknown';
    case 'sign-in-link': {
      // Runs before body validation; a request without an email is counted by IP instead.
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' && email.trim() !== '' ? `email:${email.trim().toLowerCase()}` : `ip:${req.ip ?? 'unknown'}`;
    }
    case 'customer-message':
      return req.actor?.userId ?? `ip:${req.ip ?? 'unknown'}`;
    case 'api':
      return req.actor?.sessionId ?? `ip:${req.ip ?? 'unknown'}`;
  }
}

/**
 * Runs after authentication (api-pipeline.module.ts) so `req.actor` is known: first the route's
 * own policy, then `api` for requests with a session.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const tenantId = req.tenant?.id;

    const policy = this.reflector.getAllAndOverride<RateLimitPolicyName | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (policy !== undefined) {
      await this.limiter.consume(policy, tenantId, rateLimitSubject(policy, req));
    }
    if (req.actor !== undefined) {
      await this.limiter.consume('api', tenantId, rateLimitSubject('api', req));
    }
    return true;
  }
}
