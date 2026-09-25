import { http, HttpResponse } from 'msw';

import type { Branding, ErrorResponse } from '../../src/api/generated/model';

/**
 * Default MSW handlers for component tests (web-testing rule 3). Response bodies are typed with
 * the orval-generated models, so a contract change breaks the test at compile time. Stories add
 * handlers for their endpoints here; tests override per case with `server.use(...)`.
 */

export const API = '/api/v1';

/** A typed error response in the standard envelope. */
export function errorResponse(status: number, code: string, message = 'Request failed') {
  return HttpResponse.json<ErrorResponse>({ error: { code, message } }, { status });
}

/** An available workspace; override with `available: false` for the suspended case. */
export const branding: Branding = { tenantName: 'Acme', selfRegistration: true, available: true };

export const handlers = [
  http.get(`${API}/customer/branding`, () => HttpResponse.json(branding)),
  // Anything not handled explicitly fails loudly (onUnhandledRequest: 'error' in setup.ts); this
  // keeps an unexpected API call visible as a 404 envelope instead of a network error.
  http.all(`${API}/*`, () => errorResponse(404, 'NOT_FOUND', 'Not found')),
];
