import { type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CustomerApi, OperatorApi, Public, RequirePermission } from '../../../src/authorization/registry/module-permissions.js';
import { AuthGuard } from '../../../src/identity/auth.guard.js';
import {
  CUSTOMER_TRUSTED_IDLE_MS,
  hashToken,
  idleWindowMs,
  STAFF_IDLE_MS,
  type SessionPrincipal,
} from '../../../src/identity/session.service.js';
import { appendSetCookie, parseCookies, serializeCookie } from '../../../src/platform-kernel/http/cookies.js';

import type { ResolvedTenant } from '../../../src/platform-kernel/http/request-context.js';

const TENANT: ResolvedTenant = { id: '0192f3c4-0000-7000-8000-00000000000a', slug: 'acme', status: 'active' };
const TOKEN = 'a'.repeat(43);

describe('cookies', () => {
  it('parses the first value per name and skips malformed pairs', () => {
    const cookies = parseCookies('rx_session=abc; rx_csrf="q%20w"; rx_session=evil; broken; =x; bad=%E0%A4%A');
    expect(cookies.get('rx_session')).toBe('abc');
    expect(cookies.get('rx_csrf')).toBe('q w');
    expect(cookies.has('bad')).toBe(false);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it('serializes host-only secure cookies', () => {
    const cookie = serializeCookie('rx_session', 'tok_en-1', { httpOnly: true });
    expect(cookie).toBe('rx_session=tok_en-1; Path=/; Secure; SameSite=Lax; HttpOnly');
    expect(cookie).not.toContain('Domain');
    expect(serializeCookie('rx_csrf', 'x', { httpOnly: false, maxAge: 60 })).toContain('Max-Age=60');
    expect(serializeCookie('rx_session', '', { httpOnly: true, maxAge: 0 })).toContain('Expires=Thu, 01 Jan 1970');
    expect(() => serializeCookie('rx_session', 'a;b', { httpOnly: true })).toThrow('unsafe');
  });

  it('appends Set-Cookie headers', () => {
    const headers = new Map<string, unknown>();
    const res = { getHeader: (n: string) => headers.get(n), setHeader: (n: string, v: string[]) => headers.set(n, v) };
    appendSetCookie(res, 'a=1');
    appendSetCookie(res, 'b=2');
    expect(headers.get('Set-Cookie')).toEqual(['a=1', 'b=2']);
  });
});

describe('session lifetimes', () => {
  it('uses 12 h idle for staff and 30 days for trusted customer devices', () => {
    expect(idleWindowMs('staff', true)).toBe(STAFF_IDLE_MS);
    expect(idleWindowMs('customer', true)).toBe(CUSTOMER_TRUSTED_IDLE_MS);
    expect(idleWindowMs('customer', false)).toBe(STAFF_IDLE_MS);
  });

  it('stores only a SHA-256 of the token', () => {
    expect(hashToken(TOKEN)).toHaveLength(32);
    expect(hashToken(TOKEN).toString('hex')).not.toContain(TOKEN);
  });
});

describe('AuthGuard', () => {
  class Routes {
    @RequirePermission('ticket.view')
    staff(this: void) {}
    @CustomerApi()
    customer(this: void) {}
    @Public()
    open(this: void) {}
    @OperatorApi()
    console(this: void) {}
    undecorated(this: void) {}
  }

  const principal: SessionPrincipal = {
    sessionId: '0192f3c4-0000-7000-8000-0000000000c1',
    tenantId: TENANT.id,
    userId: '0192f3c4-0000-7000-8000-0000000000a1',
    kind: 'staff',
    trustedDevice: false,
    expiresAt: Date.now() + 1000,
  };

  function run(handler: () => void, req: Record<string, unknown>, result: SessionPrincipal | undefined) {
    const sessions = { authenticate: vi.fn(() => Promise.resolve(result)) };
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { promise: new AuthGuard(sessions as never).canActivate(context), sessions };
  }

  it('sets the actor for a valid session of this tenant', async () => {
    const req: Record<string, unknown> = { hostKind: 'tenant', tenant: TENANT, headers: { cookie: `rx_session=${TOKEN}` } };
    const { promise, sessions } = run(Routes.prototype.staff, req, principal);
    await expect(promise).resolves.toBe(true);
    expect(sessions.authenticate).toHaveBeenCalledWith(TENANT.id, TOKEN);
    expect(req.actor).toEqual({ kind: 'staff', userId: principal.userId, sessionId: principal.sessionId });
  });

  it('answers 401 without a cookie, on the console host, or for another tenant session', async () => {
    const cases: [() => void, Record<string, unknown>, SessionPrincipal | undefined][] = [
      [Routes.prototype.staff, { hostKind: 'tenant', tenant: TENANT, headers: {} }, undefined],
      [Routes.prototype.customer, { hostKind: 'console', headers: { cookie: `rx_session=${TOKEN}` } }, principal],
      [Routes.prototype.staff, { hostKind: 'tenant', tenant: TENANT, headers: { cookie: `rx_session=${TOKEN}` } }, { ...principal, tenantId: '0192f3c4-0000-7000-8000-00000000000b' }],
      [Routes.prototype.undecorated, { hostKind: 'tenant', tenant: TENANT, headers: {} }, undefined],
    ];
    for (const [handler, req, result] of cases) {
      await expect(run(handler, req, result).promise).rejects.toMatchObject({ code: 'UNAUTHENTICATED', httpStatus: 401 });
    }
  });

  it('skips public and operator routes', async () => {
    for (const handler of [Routes.prototype.open, Routes.prototype.console]) {
      const { promise, sessions } = run(handler, { headers: {} }, principal);
      await expect(promise).resolves.toBe(true);
      expect(sessions.authenticate).not.toHaveBeenCalled();
    }
  });
});
