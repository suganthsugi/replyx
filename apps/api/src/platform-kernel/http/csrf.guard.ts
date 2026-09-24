import { randomBytes, timingSafeEqual } from 'node:crypto';

import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { routeAccessOf } from '../../authorization/registry/module-permissions.js';

import { AppError } from './app-error.js';
import { appendSetCookie, CSRF_COOKIE, parseCookies, serializeCookie } from './cookies.js';

import type { Request } from 'express';

/**
 * Double-submit CSRF protection (research D5), on top of `SameSite=Lax`. Sign-in sets a random,
 * non-HttpOnly `rx_csrf` cookie next to the session cookie; the web client copies it into the
 * `X-CSRF-Token` header of every state-changing request. A cross-site page can make the browser
 * send the cookie but cannot read it, so it cannot produce the header.
 *
 * Safe methods and `@Public()` routes are exempt: public routes (sign-in, sign-in links, password
 * reset) run before any session or CSRF cookie exists and act on no session. Everything else,
 * including `@OperatorApi()` routes, needs a matching header or gets 403 `CSRF_FAILED`.
 */

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfFailed(): AppError {
  return new AppError('CSRF_FAILED', 403, 'The request is missing a valid CSRF token');
}

/** Sets a fresh `rx_csrf` cookie and returns its value. `maxAge` should match the session cookie. */
export function issueCsrfCookie(res: Parameters<typeof appendSetCookie>[0], maxAgeSeconds?: number): string {
  const token = randomBytes(32).toString('base64url');
  appendSetCookie(res, serializeCookie(CSRF_COOKIE, token, { httpOnly: false, maxAge: maxAgeSeconds }));
  return token;
}

export function clearCsrfCookie(res: Parameters<typeof appendSetCookie>[0]): void {
  appendSetCookie(res, serializeCookie(CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 }));
}

/** True when the header carries exactly the cookie's (non-empty) value; constant-time. */
export function csrfTokensMatch(cookie: string | undefined, header: string | string[] | undefined): boolean {
  if (cookie === undefined || cookie === '' || typeof header !== 'string' || header === '') return false;
  const a = Buffer.from(cookie, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    const access = routeAccessOf(context.getHandler(), context.getClass());
    if (access.length === 1 && access[0]?.kind === 'public') return true;

    const cookie = parseCookies(req.headers.cookie).get(CSRF_COOKIE);
    if (!csrfTokensMatch(cookie, req.headers[CSRF_HEADER])) throw csrfFailed();
    return true;
  }
}
