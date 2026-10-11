import { createHash } from 'node:crypto';

/**
 * The id a customer uses to rate a resolved conversation (contracts/customer.yaml
 * `pendingRating.ratingId`, `PUT /customer/ratings/{id}`). Customers never see ticket ids
 * (constitution, customer-projection.ts), so the offer id is derived from the tenant and ticket
 * with a one-way hash, shaped as a UUID (version 8). The server finds the ticket again by hashing
 * the customer's own resolved tickets, so an id never reaches another customer's ticket.
 */
export function ratingOfferId(tenantId: string, ticketId: string): string {
  const hex = createHash('sha256').update(`csat:${tenantId}:${ticketId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
