import supertest from 'supertest';

import { API_PREFIX } from '../../src/app.setup.js';

import { getTestApp } from './app.js';

import type { TestTenant, TestUser } from './factories.js';
import type { Test } from 'supertest';

/**
 * HTTP clients for endpoint tests (testing-conventions rule 5). Requests go through the full
 * pipeline on the tenant's host: `asUser` sends the session and CSRF cookies and, on non-GET
 * requests, the `X-CSRF-Token` header; `asGuest` sends nothing. Paths are relative to
 * `/api/v1` unless they already start with `/api/` or `/health/`.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface TestClient {
  get(path: string): Promise<Test>;
  post(path: string, body?: object): Promise<Test>;
  put(path: string, body?: object): Promise<Test>;
  patch(path: string, body?: object): Promise<Test>;
  delete(path: string): Promise<Test>;
}

function fullPath(path: string): string {
  if (path.startsWith('/api/') || path.startsWith('/health/')) return path;
  return `/${API_PREFIX}${path.startsWith('/') ? '' : '/'}${path}`;
}

function client(host: string, options: { cookies: string[]; csrfToken?: string }): TestClient {
  const request = async (method: Method, path: string, body?: object): Promise<Test> => {
    const { app } = await getTestApp();
    let test = supertest(app.getHttpServer())[method](fullPath(path)).set('Host', host);
    if (options.cookies.length > 0) test = test.set('Cookie', options.cookies.join('; '));
    if (method !== 'get' && options.csrfToken !== undefined) test = test.set('X-CSRF-Token', options.csrfToken);
    if (body !== undefined) test = test.send(body);
    return test;
  };
  return {
    get: (path) => request('get', path),
    post: (path, body) => request('post', path, body),
    put: (path, body) => request('put', path, body),
    patch: (path, body) => request('patch', path, body),
    delete: (path) => request('delete', path),
  };
}

/** Signed in as `user` on its tenant's host (or `options.host`, for cross-host checks). */
export function asUser(user: TestUser, options: { host?: string; csrf?: boolean } = {}): TestClient {
  const cookies = [`rx_csrf=${user.csrfToken}`];
  if (user.sessionToken !== undefined) cookies.unshift(`rx_session=${user.sessionToken}`);
  return client(options.host ?? user.tenant.host, {
    cookies,
    ...(options.csrf === false ? {} : { csrfToken: user.csrfToken }),
  });
}

/** No session and no CSRF token, on a tenant host or any raw host. */
export function asGuest(tenantOrHost: TestTenant | string): TestClient {
  return client(typeof tenantOrHost === 'string' ? tenantOrHost : tenantOrHost.host, { cookies: [] });
}
