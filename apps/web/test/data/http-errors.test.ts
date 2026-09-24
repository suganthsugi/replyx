import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPermanentFailure, mapError, NETWORK_ERROR } from '../../src/data/errors';
import { http, HttpError, readCookie, resolveUrl } from '../../src/data/http';
import { shouldRetry } from '../../src/data/query-client';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'rx_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

describe('http mutator', () => {
  it('resolves paths against /api/v1 on the same origin', () => {
    expect(resolveUrl('/groups')).toBe('/api/v1/groups');
    expect(resolveUrl('groups?limit=5')).toBe('/api/v1/groups?limit=5');
    expect(resolveUrl('/api/v1/me')).toBe('/api/v1/me');
  });

  it('sends credentials, and the CSRF cookie as a header on non-GET only', async () => {
    document.cookie = 'rx_csrf=tok%20en; path=/';
    const fetchMock = mockFetch(200, { ok: true });

    await expect(http('/groups')).resolves.toEqual({ ok: true });
    const [url, getInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/groups');
    expect(getInit.credentials).toBe('include');
    expect(new Headers(getInit.headers).has('X-CSRF-Token')).toBe(false);

    await http('/groups', { method: 'post', body: JSON.stringify({ name: 'x' }) });
    const [, postInit] = fetchMock.mock.calls[1]!;
    const headers = new Headers(postInit.headers);
    expect(postInit.method).toBe('POST');
    expect(headers.get('X-CSRF-Token')).toBe('tok en');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('resolves 204 to undefined', async () => {
    mockFetch(204, undefined);
    await expect(http('/auth/sign-out', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('rejects with the error envelope, filling retryAfter from the header', async () => {
    mockFetch(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, { 'Retry-After': '12' });
    const error = await http('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, error: { code: 'RATE_LIMITED', retryAfter: 12 } });
  });

  it('keeps the envelope contract for non-JSON failures', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })));
    await expect(http('/x')).rejects.toMatchObject({ status: 502, error: { code: 'INTERNAL' } });
  });

  it('reads cookies by exact name', () => {
    expect(readCookie('rx_csrf', 'a=1; rx_csrf2=no; rx_csrf=yes')).toBe('yes');
    expect(readCookie('rx_csrf', 'a=1')).toBeUndefined();
  });
});

describe('mapError', () => {
  it('maps the envelope, validation details and retryAfter', () => {
    const error = new HttpError(400, {
      code: 'VALIDATION_FAILED',
      message: 'The request is invalid',
      details: [
        { path: 'title', issue: 'too_long' },
        { path: 'items.0.id', issue: 'required' },
      ],
    });
    expect(mapError(error)).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request is invalid',
      fieldErrors: { title: 'too_long', 'items.0.id': 'required' },
    });
    expect(mapError(new HttpError(429, { code: 'RATE_LIMITED', message: 'Slow down', retryAfter: 3 }))).toMatchObject({ retryAfter: 3 });
  });

  it('uses friendly messages for generic codes and treats anything else as a network error', () => {
    expect(mapError(new HttpError(500, { code: 'INTERNAL', message: 'x' })).message).toMatch(/our side/);
    expect(mapError(new TypeError('Failed to fetch'))).toEqual(NETWORK_ERROR);
    expect(mapError(undefined)).toEqual(NETWORK_ERROR);
  });

  it('does not retry client errors except rate limits', () => {
    const notFound = new HttpError(404, { code: 'TICKET_NOT_FOUND', message: 'x' });
    const limited = new HttpError(429, { code: 'RATE_LIMITED', message: 'x' });
    expect(isPermanentFailure(notFound)).toBe(true);
    expect(shouldRetry(0, notFound)).toBe(false);
    expect(shouldRetry(0, limited)).toBe(true);
    expect(shouldRetry(0, new TypeError('offline'))).toBe(true);
    expect(shouldRetry(2, new TypeError('offline'))).toBe(false);
  });
});
