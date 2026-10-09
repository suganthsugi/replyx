import { OutboundRefusedError, OutboundTimeoutError, outboundRequest, type OutboundRequest, type OutboundResponse } from '../../../platform-kernel/http/outbound-guard.js';
import { CommerceError, type CommerceConnector, type CommerceCredentials, type CommerceOrder } from '../ports.js';

import { isOrderList, parseOrders, SPREE_ORDER_EXPAND } from './spree-order.schema.js';

/**
 * Spree 5.5 Admin API v3 adapter (specs/002-ai-assist research R9): reads one order by number with
 * a secret key that has the `read_orders` scope. Every request goes through the outbound guard
 * (https, public addresses only, no redirects) with a 5 s limit. Nothing is ever written to the store.
 *
 * Neither the key nor response bodies appear in errors or logs.
 */

const TIMEOUT_MS = 5_000;
const ORDER_NUMBER = /^[A-Za-z0-9-]{3,32}$/;

type Send = (request: OutboundRequest) => Promise<OutboundResponse>;

export class SpreeAdminConnector implements CommerceConnector {
  readonly name = 'spree';

  constructor(private readonly send: Send = outboundRequest) {}

  async getOrder(credentials: CommerceCredentials, number: string): Promise<CommerceOrder | null> {
    if (!ORDER_NUMBER.test(number)) return null;
    const body = await this.get(credentials, `q[number_eq]=${encodeURIComponent(number)}&expand=${SPREE_ORDER_EXPAND}&limit=2`);
    const orders = parseOrders(body);
    if (orders === undefined) throw new CommerceError('bad_response', 'The store answered with an unexpected shape');
    // A filter the store does not recognise is dropped silently (Ransack), which would return
    // unrelated orders: only an order whose own number matches counts.
    return orders.find((order) => order.number.toLowerCase() === number.toLowerCase()) ?? null;
  }

  async test(credentials: CommerceCredentials): Promise<void> {
    const body = await this.get(credentials, 'limit=1');
    if (!isOrderList(body)) throw new CommerceError('bad_response', 'The store answered with an unexpected shape');
  }

  private async get(credentials: CommerceCredentials, query: string): Promise<unknown> {
    const url = `${credentials.baseUrl.replace(/\/+$/, '')}/api/v3/admin/orders?${query}`;
    let response: OutboundResponse;
    try {
      response = await this.send({
        url,
        headers: { 'X-Spree-API-Key': credentials.apiKey, Accept: 'application/json' },
        timeoutMs: TIMEOUT_MS,
      });
    } catch (error) {
      throw transportError(error);
    }
    if (response.status === 401 || response.status === 403) throw new CommerceError('auth', 'The store did not accept the key', response.status);
    if (response.status === 429) throw new CommerceError('rate_limit', 'The store is rate limiting requests', response.status);
    if (response.status === 408 || response.status === 504) throw new CommerceError('timeout', 'The store did not answer in time', response.status);
    if (response.status >= 500) throw new CommerceError('unavailable', 'The store is unavailable', response.status);
    if (response.status !== 200) throw new CommerceError('bad_response', `The store answered with status ${response.status}`, response.status);
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new CommerceError('bad_response', 'The store did not answer with JSON', response.status);
    }
  }
}

function transportError(error: unknown): CommerceError {
  if (error instanceof OutboundTimeoutError) return new CommerceError('timeout', 'The store did not answer in time');
  if (error instanceof OutboundRefusedError) {
    return error.reason === 'unresolvable'
      ? new CommerceError('unavailable', 'The store address could not be resolved')
      : new CommerceError('not_allowed', `The store address was refused (${error.reason})`);
  }
  // Socket errors (refused, reset, TLS): the message may name the host but never the key.
  return new CommerceError('unavailable', 'The store could not be reached');
}
