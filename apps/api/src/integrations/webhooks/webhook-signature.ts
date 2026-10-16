import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing (research D16, contracts/webhook-events.md):
 * `ReplyX-Signature: t={unix seconds},v1={hex HMAC-SHA256(secret, t + "." + raw body)}`.
 * Receivers reject a `t` older than 5 minutes and compare in constant time; `verifyWebhookSignature`
 * is what they do, kept here for tests and the developer doc.
 */

/** 32 random bytes; shown to the admin once, stored only sealed. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): boolean {
  const parts = new Map(header.split(',').map((part) => part.split('=', 2) as [string, string]));
  const timestamp = Number(parts.get('t'));
  const given = parts.get('v1');
  if (!Number.isInteger(timestamp) || given === undefined || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = signatureHeader(secret, timestamp, body).split('v1=')[1]!;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
