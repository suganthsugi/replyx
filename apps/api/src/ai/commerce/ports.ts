/**
 * Port for the tenant's store (specs/002-ai-assist research R9). The assistant only ever reads
 * orders; nothing here changes anything in the store. Like the AI providers, every call takes the
 * tenant's credentials explicitly: each tenant connects its own store, so there is no process-wide
 * store or key.
 */

export interface CommerceCredentials {
  /** `https://shop.example.com`, no trailing slash; already past the outbound guard when saved. */
  baseUrl: string;
  apiKey: string;
}

export interface CommerceOrderItem {
  name: string;
  quantity: number | null;
  /** Variant options as the store words them, e.g. "Size: M, Color: Blue". */
  options: string | null;
}

export interface CommerceShipment {
  tracking: string | null;
  trackingUrl: string | null;
  state: string | null;
}

/** What the assistant may know about one order. Dates are ISO 8601 strings. */
export interface CommerceOrder {
  number: string;
  /** The order's email; the caller compares it with the ticket customer's email (case-insensitive). */
  email: string | null;
  state: string | null;
  shipmentState: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  items: CommerceOrderItem[];
  shipments: CommerceShipment[];
}

/**
 * - `auth`: the store did not accept the key, or the key may not read orders.
 * - `not_allowed`: the address was refused by the outbound guard (private address, not https, ...).
 * - `rate_limit`, `unavailable`, `timeout`: the store is busy, down or slow; retry later.
 * - `bad_response`: the address answered, but not like the store's Admin API.
 */
export type CommerceErrorKind = 'auth' | 'not_allowed' | 'rate_limit' | 'unavailable' | 'timeout' | 'bad_response';

/** Messages never carry the key, the request URL's query, or a response body. */
export class CommerceError extends Error {
  constructor(
    readonly kind: CommerceErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CommerceError';
  }
}

export interface CommerceConnector {
  readonly name: string;
  /** The order with this number, or null when the store has none. Throws `CommerceError`. */
  getOrder(credentials: CommerceCredentials, number: string): Promise<CommerceOrder | null>;
  /** Succeeds when the store accepts the key and answers like its Admin API. Throws `CommerceError`. */
  test(credentials: CommerceCredentials): Promise<void>;
}

export const COMMERCE_CONNECTOR = Symbol('COMMERCE_CONNECTOR');
