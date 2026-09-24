/**
 * The only error type handlers and services throw for client-facing failures (api-conventions,
 * contracts/README.md). `error.filter.ts` turns it into
 * `{ "error": { "code", "message", "details"?, "retryAfter"? } }`.
 */

export interface ErrorDetail {
  /** Dot-joined input path, e.g. `title` or `items.0.id`. */
  path: string;
  /** snake_case reason, e.g. `too_long`, `required`, `unrecognized_key`. */
  issue: string;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

export class AppError extends Error {
  readonly retryAfter?: number;

  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: readonly ErrorDetail[],
    options?: { retryAfter?: number },
  ) {
    super(message);
    if (!CODE_PATTERN.test(code)) {
      throw new TypeError(`AppError code must match ${CODE_PATTERN.source}: ${code}`);
    }
    this.name = 'AppError';
    this.retryAfter = options?.retryAfter;
  }
}

/**
 * 404 for a missing resource, another tenant's resource, or one the caller cannot see: the same
 * code and message in every case (constitution I). `resource` is the registry resource name.
 */
export function notFound(resource: string): AppError {
  const words = resource.split('_');
  const label = words.join(' ');
  return new AppError(
    `${words.join('_').toUpperCase()}_NOT_FOUND`,
    404,
    `${label.charAt(0).toUpperCase()}${label.slice(1)} not found`,
  );
}

/** 403: the caller can see the resource but may not perform the action. */
export function permissionDenied(): AppError {
  return new AppError('PERMISSION_DENIED', 403, 'You do not have permission to do this');
}

/** 409: the request conflicts with the resource's current state. */
export function conflict(code: string, message = 'The request conflicts with the current state'): AppError {
  return new AppError(code, 409, message);
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 401, 'Sign in to continue');
}

export function validationFailed(details: readonly ErrorDetail[]): AppError {
  return new AppError('VALIDATION_FAILED', 400, 'The request is invalid', details);
}

export function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 429, 'Too many requests, try again later', undefined, {
    retryAfter: Math.max(1, Math.ceil(retryAfterSeconds)),
  });
}
