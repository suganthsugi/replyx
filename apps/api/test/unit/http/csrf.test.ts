import { type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { OperatorApi, Public, RequirePermission } from '../../../src/authorization/registry/module-permissions.js';
import {
  clearCsrfCookie,
  CsrfGuard,
  csrfTokensMatch,
  issueCsrfCookie,
} from '../../../src/platform-kernel/http/csrf.guard.js';

const TOKEN = 'c'.repeat(43);

class Routes {
  @RequirePermission('ticket.edit')
  staff(this: void) {}
  @Public()
  open(this: void) {}
  @OperatorApi()
  console(this: void) {}
}

function run(handler: () => void, req: { method: string; headers: Record<string, string> }): boolean {
  const context = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return new CsrfGuard().canActivate(context);
}

describe('CsrfGuard', () => {
  it('lets safe methods through without a token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run(Routes.prototype.staff, { method, headers: {} })).toBe(true);
    }
  });

  it('accepts a non-GET request whose header matches the cookie', () => {
    const headers = { cookie: `rx_session=s; rx_csrf=${TOKEN}`, 'x-csrf-token': TOKEN };
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(run(Routes.prototype.staff, { method, headers })).toBe(true);
    }
  });

  it('answers 403 CSRF_FAILED for a missing, empty or different token', () => {
    const cases: Record<string, string>[] = [
      { cookie: `rx_csrf=${TOKEN}` },
      { 'x-csrf-token': TOKEN },
      { cookie: 'rx_csrf=', 'x-csrf-token': '' },
      { cookie: `rx_csrf=${TOKEN}`, 'x-csrf-token': `${TOKEN}x` },
      { cookie: `rx_csrf=${TOKEN}`, 'x-csrf-token': 'd'.repeat(43) },
    ];
    for (const headers of cases) {
      expect(() => run(Routes.prototype.staff, { method: 'POST', headers })).toThrow(
        expect.objectContaining({ code: 'CSRF_FAILED', httpStatus: 403 }),
      );
    }
  });

  it('exempts public routes but not operator routes', () => {
    expect(run(Routes.prototype.open, { method: 'POST', headers: {} })).toBe(true);
    expect(() => run(Routes.prototype.console, { method: 'POST', headers: {} })).toThrow(
      expect.objectContaining({ code: 'CSRF_FAILED' }),
    );
  });

  it('matches tokens exactly', () => {
    expect(csrfTokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(csrfTokensMatch(undefined, TOKEN)).toBe(false);
    expect(csrfTokensMatch(TOKEN, [TOKEN])).toBe(false);
  });
});

describe('CSRF cookie', () => {
  function response() {
    const headers = new Map<string, unknown>();
    return {
      headers,
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string[]) => headers.set(name, value),
    };
  }

  it('issues a readable (non-HttpOnly) random cookie', () => {
    const res = response();
    const token = issueCsrfCookie(res, 60);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [cookie] = res.headers.get('Set-Cookie') as string[];
    expect(cookie).toBe(`rx_csrf=${token}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    expect(issueCsrfCookie(response())).not.toBe(token);
  });

  it('clears the cookie', () => {
    const res = response();
    clearCsrfCookie(res);
    expect((res.headers.get('Set-Cookie') as string[])[0]).toContain('rx_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0');
  });
});
