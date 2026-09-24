/**
 * The orval mutator (orval.config.ts): every generated API call goes through `http`.
 *
 * - Same-origin: the tenant comes from the host, so paths are resolved against `/api/v1` on the
 *   current origin (generated paths are relative to the OpenAPI server URL).
 * - Session cookies ride along (`credentials: 'include'`); non-GET requests send the `rx_csrf`
 *   cookie back as `X-CSRF-Token` (double-submit CSRF, research D5).
 * - Resolves to the parsed body (`includeHttpResponseReturnType: false`); rejects with an
 *   `HttpError` carrying the standard `{ error: { code, message, details?, retryAfter? } }`
 *   envelope, which `errors.ts` maps for the UI.
 */

export const API_BASE = '/api/v1';
export const CSRF_COOKIE = 'rx_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { path: string; issue: string }[];
  retryAfter?: number;
}

export class HttpError extends Error {
  readonly error: ApiErrorBody;
  readonly status: number;

  constructor(status: number, error: ApiErrorBody) {
    super(error.message);
    this.name = 'HttpError';
    this.status = status;
    this.error = error;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(name: string, cookieString: string = document.cookie): string | undefined {
  for (const part of cookieString.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function resolveUrl(url: string): string {
  if (/^https?:\/\//.test(url) || url.startsWith(`${API_BASE}/`) || url === API_BASE) return url;
  return `${API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

function isErrorBody(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function http<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) headers.set(CSRF_HEADER, csrf);
  }
  if (options.body !== undefined && options.body !== null && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(resolveUrl(url), { ...options, method, headers, credentials: 'include' });
  const body = await parseBody(response);
  if (response.ok) return body as T;

  if (isErrorBody(body)) {
    const retryHeader = Number(response.headers.get('Retry-After'));
    const retryAfter = body.error.retryAfter ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined);
    throw new HttpError(response.status, { ...body.error, ...(retryAfter === undefined ? {} : { retryAfter }) });
  }
  // Not our envelope (e.g. a proxy error page): keep the contract anyway.
  throw new HttpError(response.status, {
    code: response.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR',
    message: 'Something went wrong',
  });
}

export default http;
