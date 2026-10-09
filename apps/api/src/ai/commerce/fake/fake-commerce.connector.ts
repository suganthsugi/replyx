import { CommerceError, type CommerceConnector, type CommerceCredentials, type CommerceOrder } from '../ports.js';

/**
 * Deterministic stand-in for a store (`COMMERCE_PROVIDER=fake`): tests, e2e and offline dev never
 * reach the network (specs/002-ai-assist research R9, R15).
 *
 * Fixture orders:
 * - `R100200`: shipped, with tracking; its email is the seeded customer's (`customer@acme.test`,
 *   the dev-seed convention `<local>@<tenant slug>.test`; `COMMERCE_FAKE_CUSTOMER_EMAIL` changes it).
 * - `R999999`: belongs to another customer (`someone.else@example.test`).
 * Tests whose customers have generated emails call `useCustomerEmail(email)` or replace `fixtures`;
 * `reset()` restores the defaults and clears `calls`.
 *
 * Keys: `fake-invalid` → `auth`, `fake-down` → `unavailable`, `fake-timeout` → `timeout`; anything
 * else works.
 */

export const FAKE_CUSTOMER_EMAIL = 'customer@acme.test';
export const FAKE_OTHER_EMAIL = 'someone.else@example.test';

const DAY_MS = 86_400_000;

export class FakeCommerceConnector implements CommerceConnector {
  readonly name = 'fake';
  readonly calls: { method: 'getOrder' | 'test'; number?: string; baseUrl: string }[] = [];
  /** Keyed by upper-case order number. */
  fixtures = new Map<string, CommerceOrder>();

  constructor(
    private customerEmail: string = process.env.COMMERCE_FAKE_CUSTOMER_EMAIL ?? FAKE_CUSTOMER_EMAIL,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.fixtures = this.defaults();
  }

  /** Makes `R100200` belong to this email. */
  useCustomerEmail(email: string): void {
    this.customerEmail = email;
    const order = this.fixtures.get('R100200');
    if (order !== undefined) this.fixtures.set('R100200', { ...order, email });
  }

  reset(): void {
    this.calls.length = 0;
    this.customerEmail = process.env.COMMERCE_FAKE_CUSTOMER_EMAIL ?? FAKE_CUSTOMER_EMAIL;
    this.fixtures = this.defaults();
  }

  getOrder(credentials: CommerceCredentials, number: string): Promise<CommerceOrder | null> {
    this.calls.push({ method: 'getOrder', number, baseUrl: credentials.baseUrl });
    return this.answer(credentials, () => {
      const order = this.fixtures.get(number.trim().toUpperCase());
      return order === undefined ? null : structuredClone(order);
    });
  }

  test(credentials: CommerceCredentials): Promise<void> {
    this.calls.push({ method: 'test', baseUrl: credentials.baseUrl });
    return this.answer(credentials, () => undefined);
  }

  private answer<T>(credentials: CommerceCredentials, result: () => T): Promise<T> {
    if (credentials.apiKey === 'fake-invalid') return Promise.reject(new CommerceError('auth', 'The store did not accept the key', 401));
    if (credentials.apiKey === 'fake-down') return Promise.reject(new CommerceError('unavailable', 'The store is unavailable', 503));
    if (credentials.apiKey === 'fake-timeout') return Promise.reject(new CommerceError('timeout', 'The store did not answer in time'));
    return Promise.resolve(result());
  }

  private defaults(): Map<string, CommerceOrder> {
    const completedAt = new Date(this.now().getTime() - 5 * DAY_MS).toISOString();
    return new Map<string, CommerceOrder>([
      [
        'R100200',
        {
          number: 'R100200',
          email: this.customerEmail,
          state: 'complete',
          shipmentState: 'shipped',
          completedAt,
          canceledAt: null,
          items: [
            { name: 'Classic T-Shirt', quantity: 2, options: 'Size: M, Color: Blue' },
            { name: 'Canvas Tote', quantity: 1, options: null },
          ],
          shipments: [{ tracking: 'TRK100200', trackingUrl: 'https://tracking.example.test/TRK100200', state: 'shipped' }],
        },
      ],
      [
        'R999999',
        {
          number: 'R999999',
          email: FAKE_OTHER_EMAIL,
          state: 'complete',
          shipmentState: 'pending',
          completedAt,
          canceledAt: null,
          items: [{ name: 'Leather Wallet', quantity: 1, options: null }],
          shipments: [{ tracking: null, trackingUrl: null, state: 'pending' }],
        },
      ],
    ]);
  }
}
