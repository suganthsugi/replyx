/**
 * Minimal cookie parsing and serializing for the session and CSRF cookies (research D5), shared
 * by HTTP guards and the Socket.IO handshake. Cookies are always host-only: no `Domain`, so a
 * cookie for one tenant host is never sent to another.
 */

export const SESSION_COOKIE = 'rx_session';
export const CSRF_COOKIE = 'rx_csrf';

/** Parses a `Cookie` header. The first occurrence of a name wins; malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (name === '' || cookies.has(name)) continue;
    let value = pair.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Invalid percent-encoding: ignore the cookie.
    }
  }
  return cookies;
}

export interface CookieOptions {
  httpOnly: boolean;
  /** Seconds; omitted = browser-session cookie; 0 = delete. */
  maxAge?: number;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VALUE_PATTERN = /^[A-Za-z0-9_\-.~]*$/;

/** `Secure; SameSite=Lax; Path=/`, host-only. Values must be URL-safe (tokens are base64url). */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!NAME_PATTERN.test(name) || !VALUE_PATTERN.test(value)) {
    throw new Error('Cookie name or value contains unsafe characters');
  }
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Lax'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    if (options.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

/** Adds a `Set-Cookie` header without dropping ones already set on the response. */
export function appendSetCookie(
  res: { getHeader(name: string): unknown; setHeader(name: string, value: string[]): unknown },
  cookie: string,
): void {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? (existing as string[]) : typeof existing === 'string' ? [existing] : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}
