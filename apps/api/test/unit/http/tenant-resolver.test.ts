import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AllowSuspended,
  normalizeHost,
  slugFromHost,
  TenantResolver,
  TenantResolverMiddleware,
  TenantStatusGuard,
} from '../../../src/platform-kernel/http/tenant-resolver.middleware.js';

import type { ResolvedTenant } from '../../../src/platform-kernel/http/request-context.js';
import type { Request, Response } from 'express';

const ACME: ResolvedTenant = { id: '0192f3c4-0000-7000-8000-00000000000a', slug: 'acme', status: 'active' };

/** Minimal stand-in for `db.selectFrom('tenants').select(...).where('slug', '=', x).executeTakeFirst()`. */
function fakeDb(rows: ResolvedTenant[]) {
  const where = vi.fn((_column: string, _op: string, slug: string) => ({
    executeTakeFirst: () => Promise.resolve(rows.find((row) => row.slug === slug)),
  }));
  return { db: { selectFrom: () => ({ select: () => ({ where }) }) }, where };
}

describe('host parsing', () => {
  it('normalizes case, port and trailing dot', () => {
    expect(normalizeHost('Acme.LocalHost:5173')).toBe('acme.localhost');
    expect(normalizeHost('acme.localhost.')).toBe('acme.localhost');
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost('acme.localhost/evil')).toBeUndefined();
    expect(normalizeHost('[::1]:3000')).toBeUndefined();
  });

  it('accepts exactly one valid label under the base domain', () => {
    expect(slugFromHost('acme.localhost', 'localhost')).toBe('acme');
    expect(slugFromHost('my-co.replyx.app', 'replyx.app')).toBe('my-co');
    for (const host of ['localhost', 'a.b.localhost', 'ab.localhost', 'a--b.localhost', '-ab.localhost', 'acme.localhostx', 'acmelocalhost']) {
      expect(slugFromHost(host, 'localhost')).toBeUndefined();
    }
  });
});

describe('TenantResolver', () => {
  beforeEach(() => {
    vi.stubEnv('BASE_DOMAIN', 'localhost');
    vi.stubEnv('CONSOLE_HOST', 'console.localhost');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves a known tenant and the console host', async () => {
    const { db } = fakeDb([ACME]);
    const resolver = new TenantResolver(db as never);
    await expect(resolver.resolve('acme.localhost:5173')).resolves.toEqual({ kind: 'tenant', tenant: ACME });
    await expect(resolver.resolve('Console.localhost')).resolves.toEqual({ kind: 'console' });
  });

  it('answers TENANT_NOT_FOUND for unknown, reserved and foreign hosts without a lookup for invalid ones', async () => {
    const { db, where } = fakeDb([ACME, { ...ACME, slug: 'admin' }]);
    const resolver = new TenantResolver(db as never);
    for (const host of ['nope.localhost', 'admin.localhost', 'www.localhost', 'localhost', 'evil.com', undefined]) {
      await expect(resolver.resolve(host)).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', httpStatus: 404 });
    }
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('requires BASE_DOMAIN and CONSOLE_HOST', () => {
    vi.stubEnv('BASE_DOMAIN', '');
    expect(() => new TenantResolver(fakeDb([]).db as never)).toThrow('BASE_DOMAIN');
  });

  it('middleware attaches the tenant from Host only and skips health checks', async () => {
    const middleware = new TenantResolverMiddleware(new TenantResolver(fakeDb([ACME]).db as never));
    const next = vi.fn();
    const req = { headers: { host: 'acme.localhost', 'x-forwarded-host': 'globex.localhost' }, originalUrl: '/api/v1/x' } as unknown as Request;
    await middleware.use(req, {} as Response, next);
    expect(req.tenant).toEqual(ACME);
    expect(req.hostKind).toBe('tenant');

    const health = { headers: {}, originalUrl: '/health/ready' } as unknown as Request;
    await middleware.use(health, {} as Response, next);
    expect(health.tenant).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('TenantStatusGuard', () => {
  @Controller()
  class Routes {
    @Get('a')
    normal(this: void) {}

    @Get('b')
    @AllowSuspended()
    allowed(this: void) {}
  }

  function contextFor(handler: () => void, tenant?: ResolvedTenant, type = 'http') {
    return {
      getType: () => type,
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => ({ tenant }) }),
    } as unknown as ExecutionContext;
  }

  const guard = new TenantStatusGuard(new Reflector());
  const suspended = { ...ACME, status: 'suspended' as const };

  it('passes active tenants, the console host and non-HTTP contexts', () => {
    expect(guard.canActivate(contextFor(Routes.prototype.normal, ACME))).toBe(true);
    expect(guard.canActivate(contextFor(Routes.prototype.normal, undefined))).toBe(true);
    expect(guard.canActivate(contextFor(Routes.prototype.normal, suspended, 'ws'))).toBe(true);
  });

  it('answers TENANT_SUSPENDED unless the route allows it', () => {
    expect(() => guard.canActivate(contextFor(Routes.prototype.normal, suspended))).toThrow(
      expect.objectContaining({ code: 'TENANT_SUSPENDED', httpStatus: 503 }),
    );
    expect(guard.canActivate(contextFor(Routes.prototype.allowed, suspended))).toBe(true);
  });
});
