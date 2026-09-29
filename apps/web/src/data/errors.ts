import { HttpError } from './http';

/**
 * The one place that turns API failures into something the UI renders (data-hooks rule 3).
 * Components branch on `code`, never on HTTP status: a 404 can mean "missing" or "not visible
 * to you", and the code says which resource.
 */

export interface UiError {
  code: string;
  message: string;
  /** Seconds until retrying makes sense (`RATE_LIMITED`). */
  retryAfter?: number;
  /** Validation issues by field path (`title`, `items.0.id`) → snake_case issue. */
  fieldErrors?: Record<string, string>;
  /** A value that would pass validation, by field path (e.g. an AA-contrast shade for `insufficient_contrast`). */
  fieldSuggestions?: Record<string, string>;
  /** `RETENTION_CONFIRMATION_REQUIRED`: closed tickets a shorter retention would delete; resend the save with `confirmPurgeCount`. */
  retentionConfirmation?: { purgeCount: number };
  /** `AUDIT_RETENTION_CONFIRMATION_REQUIRED`: audit log entries a shorter `auditRetention` would delete; resend the save with `confirmAuditPurgeCount`. */
  auditRetentionConfirmation?: { purgeCount: number };
}

export const NETWORK_ERROR: UiError = {
  code: 'NETWORK_ERROR',
  message: 'Could not reach the server. Check your connection and try again.',
};

const FRIENDLY_MESSAGES: Record<string, string> = {
  INTERNAL: 'Something went wrong on our side. Try again in a moment.',
  CSRF_FAILED: 'Your session needs a refresh. Reload the page and try again.',
  UNAUTHENTICATED: 'Sign in to continue.',
  TENANT_SUSPENDED: 'This workspace is currently unavailable.',
  ALREADY_TRIAGED: 'Someone else already triaged this ticket.',
  GROUP_INACTIVE: 'That group is no longer active. Pick another destination.',
  OWNER_NOT_ELIGIBLE: 'That owner does not have access to the destination group.',
};

export function isApiError(raw: unknown): raw is { error: { code: string; message: string; details?: unknown; retryAfter?: unknown } } {
  if (typeof raw !== 'object' || raw === null) return false;
  const error = (raw as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

function toFieldErrors(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const detail of details) {
    const { path, issue } = (detail ?? {}) as { path?: unknown; issue?: unknown };
    if (typeof path === 'string' && typeof issue === 'string' && result[path] === undefined) result[path] = issue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** A value that would pass validation, by field path, e.g. `brandColors.primary` → an AA-compliant shade for `insufficient_contrast`. */
function toFieldSuggestions(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const detail of details) {
    const { path, suggestion } = (detail ?? {}) as { path?: unknown; suggestion?: unknown };
    if (typeof path === 'string' && typeof suggestion === 'string' && result[path] === undefined) result[path] = suggestion;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toPurgeConfirmation(
  expectedCode: string,
  path: string,
  code: string,
  details: unknown,
): { purgeCount: number } | undefined {
  if (code !== expectedCode || !Array.isArray(details)) return undefined;
  for (const detail of details) {
    const { path: detailPath, purgeCount } = (detail ?? {}) as { path?: unknown; purgeCount?: unknown };
    if (detailPath === path && typeof purgeCount === 'number') return { purgeCount };
  }
  return undefined;
}

export function mapError(raw: unknown): UiError {
  if (!isApiError(raw)) return NETWORK_ERROR;
  const { code, message, details, retryAfter } = raw.error;
  const fieldErrors = toFieldErrors(details);
  const fieldSuggestions = toFieldSuggestions(details);
  const retentionConfirmation = toPurgeConfirmation('RETENTION_CONFIRMATION_REQUIRED', 'confirmPurgeCount', code, details);
  const auditRetentionConfirmation = toPurgeConfirmation(
    'AUDIT_RETENTION_CONFIRMATION_REQUIRED',
    'confirmAuditPurgeCount',
    code,
    details,
  );
  return {
    code,
    message: FRIENDLY_MESSAGES[code] ?? message,
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
    ...(fieldSuggestions === undefined ? {} : { fieldSuggestions }),
    ...(retentionConfirmation === undefined ? {} : { retentionConfirmation }),
    ...(auditRetentionConfirmation === undefined ? {} : { auditRetentionConfirmation }),
  };
}

/** Client errors that retrying won't fix (everything 4xx except rate limits). */
export function isPermanentFailure(raw: unknown): boolean {
  return raw instanceof HttpError && raw.status >= 400 && raw.status < 500 && raw.status !== 429;
}
