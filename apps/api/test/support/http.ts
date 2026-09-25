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

function client(host: string, options: { cookies: string[]; csrfToken?: string; supportToken?: string }): TestClient {
  const request = async (method: Method, path: string, body?: object): Promise<Test> => {
    const { app } = await getTestApp();
    let test = supertest(app.getHttpServer())[method](fullPath(path)).set('Host', host);
    if (options.cookies.length > 0) test = test.set('Cookie', options.cookies.join('; '));
    if (options.supportToken !== undefined) test = test.set('X-Support-Token', options.supportToken);
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

/** `CONSOLE_HOST` from support/env.ts: the platform console serves no tenant. */
export const CONSOLE_HOST = 'console.localhost';

/** The operator the app bootstraps from `OPERATOR_BOOTSTRAP_*` on start-up (support/env.ts). */
export const BOOTSTRAP_OPERATOR = { email: 'operator@example.test', password: 'operator-password' };

export interface OperatorSession {
  client: TestClient;
  operator: { id: string; email: string; name: string };
}

/**
 * Signs an operator in on the console host and returns a client carrying `rx_op_session` and the
 * CSRF pair, for `@OperatorApi()` routes.
 */
export async function asOperator(credentials = BOOTSTRAP_OPERATOR): Promise<OperatorSession> {
  const response = await asGuest(CONSOLE_HOST).post('/platform/auth/sign-in', credentials);
  if (response.status !== 200) {
    throw new Error(`Operator sign-in failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  const cookies = setCookieValues(response.headers['set-cookie']);
  const session = cookies.get('rx_op_session');
  const csrf = cookies.get('rx_csrf');
  if (session === undefined || csrf === undefined) throw new Error('Operator sign-in set no session cookie');
  return {
    client: client(CONSOLE_HOST, { cookies: [`rx_op_session=${session}`, `rx_csrf=${csrf}`], csrfToken: csrf }),
    operator: response.body as { id: string; email: string; name: string },
  };
}

/** A client that carries a support token instead of a session (FR-001a), on the tenant's host. */
export function asSupport(tenant: TestTenant, token: string): TestClient {
  return client(tenant.host, { cookies: [], supportToken: token });
}

/** Cookie name to value, from a response's `Set-Cookie` header. */
export function setCookieValues(raw: unknown): Map<string, string> {
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const cookies = new Map<string, string>();
  for (const cookie of list) {
    const [pair] = cookie.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair === undefined || index <= 0) continue;
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return cookies;
}
