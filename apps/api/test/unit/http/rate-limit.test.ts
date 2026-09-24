import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { Clock } from '../../../src/platform-kernel/clock.js';
import {
  RateLimit,
  RateLimitGuard,
  RateLimiter,
  rateLimitKey,
  rateLimitSubject,
} from '../../../src/platform-kernel/http/rate-limit.js';

import type { Request } from 'express';

class FixedClock extends Clock {
  now(): Date {
    return new Date(1_000_000);
  }
}

const TENANT = '0192f3c4-0000-7000-8000-00000000000a';

function limiterWith(evalResult: () => Promise<unknown>) {
  const redis = { eval: vi.fn(evalResult) };
  return { limiter: new RateLimiter(new FixedClock(), redis as never), redis };
}

describe('RateLimiter', () => {
  it('passes the policy window and limit to the sliding-window script', async () => {
    const { limiter, redis } = limiterWith(() => Promise.resolve(0));
    await limiter.consume('sign-in', TENANT, '10.0.0.1');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('ZREMRANGEBYSCORE'),
      1,
      rateLimitKey('sign-in', TENANT, '10.0.0.1'),
      1_000_000,
      60_000,
      10,
      expect.stringMatching(/^1000000:/),
    );
  });

  it('throws 429 RATE_LIMITED with retryAfter in whole seconds', async () => {
    const { limiter } = limiterWith(() => Promise.resolve(1_500));
    await expect(limiter.consume('api', TENANT, 's')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      retryAfter: 2,
    });
  });

  it('allows the request when Redis fails', async () => {
    const { limiter } = limiterWith(() => Promise.reject(new Error('down')));
    await expect(limiter.consume('api', TENANT, 's')).resolves.toBeUndefined();
  });

  it('keys by policy and tenant and never stores the raw subject', () => {
    const key = rateLimitKey('sign-in-link', TENANT, 'email:a@b.test');
    expect(key).toMatch(new RegExp(`^rl:sign-in-link:${TENANT}:[A-Za-z0-9_-]{22}$`));
    expect(key).not.toContain('a@b.test');
    expect(rateLimitKey('sign-in-link', undefined, 'x')).toMatch(/^rl:sign-in-link:-:/);
    expect(rateLimitKey('api', TENANT, 'x')).not.toBe(rateLimitKey('api', '0192f3c4-0000-7000-8000-00000000000b', 'x'));
  });
});

describe('rateLimitSubject', () => {
  const req = (extra: Partial<Request>) => ({ ip: '10.0.0.1', ...extra }) as Request;

  it('uses the IP, email, customer and session per policy', () => {
    const actor = { kind: 'customer' as const, userId: 'u1', sessionId: 's1' };
    expect(rateLimitSubject('sign-in', req({}))).toBe('10.0.0.1');
    expect(rateLimitSubject('sign-in-link', req({ body: { email: ' A@B.test ' } }))).toBe('email:a@b.test');
    expect(rateLimitSubject('sign-in-link', req({ body: {} }))).toBe('ip:10.0.0.1');
    expect(rateLimitSubject('customer-message', req({ actor }))).toBe('u1');
    expect(rateLimitSubject('api', req({ actor }))).toBe('s1');
  });
});

describe('RateLimitGuard', () => {
  class Routes {
    @RateLimit('sign-in')
    signIn(this: void) {}
    plain(this: void) {}
  }

  function run(handler: () => void, req: Partial<Request>) {
    const limiter = { consume: vi.fn(() => Promise.resolve()) };
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => ({ ip: '10.0.0.1', headers: {}, ...req }) }),
    } as unknown as ExecutionContext;
    return { promise: new RateLimitGuard(limiter as never, new Reflector()).canActivate(context), limiter };
  }

  it('applies the route policy and the per-session api policy', async () => {
    const tenant = { id: TENANT, slug: 'acme', status: 'active' as const };
    const actor = { kind: 'staff' as const, userId: 'u1', sessionId: 's1' };
    const { promise, limiter } = run(Routes.prototype.signIn, { tenant, actor });
    await expect(promise).resolves.toBe(true);
    expect(limiter.consume.mock.calls).toEqual([
      ['sign-in', TENANT, '10.0.0.1'],
      ['api', TENANT, 's1'],
    ]);
  });

  it('does nothing for an undecorated route without a session', async () => {
    const { promise, limiter } = run(Routes.prototype.plain, {});
    await expect(promise).resolves.toBe(true);
    expect(limiter.consume).not.toHaveBeenCalled();
  });
});
