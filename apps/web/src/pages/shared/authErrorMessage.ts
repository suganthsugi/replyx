import type { UiError } from '../../data/errors';

/**
 * Copy for identity error codes that need something more specific than the raw API message
 * (data-hooks `mapError` already covers generic codes like `UNAUTHENTICATED`). Shared by the
 * staff and customer sign-in pages.
 */
export function authErrorMessage(error: UiError): string {
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'Wrong email or password.';
    case 'ACCOUNT_LOCKED':
      return 'Too many failed sign-in attempts. This account is temporarily locked — try again in a few minutes.';
    case 'RATE_LIMITED':
      return error.retryAfter === undefined
        ? 'Too many attempts. Try again shortly.'
        : `Too many attempts. Try again in ${formatRetryAfter(error.retryAfter)}.`;
    case 'LINK_INVALID_OR_EXPIRED':
      return 'This link is no longer valid. Request a new one.';
    default:
      return error.message;
  }
}

/** Whether a validation failure is the (hidden) `token` field rather than something the user typed. */
export function isInvalidToken(error: UiError): boolean {
  return error.code === 'LINK_INVALID_OR_EXPIRED' || error.fieldErrors?.token !== undefined;
}

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
