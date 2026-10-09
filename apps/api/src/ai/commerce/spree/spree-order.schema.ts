import { z } from 'zod';

import type { CommerceOrder, CommerceOrderItem, CommerceShipment } from '../ports.js';

/**
 * The one place that knows Spree 5.5's Admin API v3 order shape (specs/002-ai-assist research R9),
 * checked against a live 5.5.4 store. Everything is tolerant: unknown fields are ignored, missing
 * optional fields become null, and an association that came back as bare ids (not expanded) is
 * skipped instead of failing the lookup.
 *
 * Live facts: `GET /api/v3/admin/orders?q[number_eq]=...&expand=items,fulfillments` answers
 * `{ data: [...], meta }`; `q[number_eq]` is honoured; `line_items` and `shipments` are not expand
 * keys (silently ignored). Orders carry number, email, status, fulfillment_status, completed_at and
 * canceled_at; items carry name, quantity and options_text; fulfillments carry tracking,
 * tracking_url and status.
 */

/** Expand keys sent with the order query. */
export const SPREE_ORDER_EXPAND = 'items,fulfillments';

const Text = z.string().nullish();

const ItemSchema = z.object({ name: Text, quantity: z.number().nullish(), options_text: Text }).loose();

const FulfillmentSchema = z.object({ tracking: Text, tracking_url: Text, status: Text }).loose();

const OrderSchema = z
  .object({
    number: z.string().min(1),
    email: Text,
    status: Text,
    fulfillment_status: Text,
    completed_at: Text,
    canceled_at: Text,
    items: z.array(z.unknown()).nullish(),
    fulfillments: z.array(z.unknown()).nullish(),
  })
  .loose();

/** `{ data: [...], meta }` of a list endpoint; orders without a number are dropped, not fatal. */
export const OrderListSchema = z.object({ data: z.array(z.unknown()) }).loose();

function parseAll<T extends z.ZodType>(schema: T, values: unknown[] | null | undefined): z.infer<T>[] {
  const parsed: z.infer<T>[] = [];
  for (const value of values ?? []) {
    const result = schema.safeParse(value);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

function toItem(raw: z.infer<typeof ItemSchema>): CommerceOrderItem {
  return { name: raw.name ?? '', quantity: raw.quantity ?? null, options: raw.options_text?.trim() ? raw.options_text : null };
}

function toShipment(raw: z.infer<typeof FulfillmentSchema>): CommerceShipment {
  return { tracking: raw.tracking ?? null, trackingUrl: raw.tracking_url ?? null, state: raw.status ?? null };
}

/**
 * `status` alone is not reliable for completion (a completed order can still read "draft"), so the
 * dates decide first: canceled, then completed, else whatever `status` says.
 */
function orderState(raw: z.infer<typeof OrderSchema>): string | null {
  if (raw.canceled_at != null) return 'canceled';
  if (raw.completed_at != null) return 'complete';
  return raw.status ?? null;
}

/** Orders in a list response that parse; the caller picks the one whose number matches. */
export function parseOrders(body: unknown): CommerceOrder[] | undefined {
  const list = OrderListSchema.safeParse(body);
  if (!list.success) return undefined;
  const orders: CommerceOrder[] = [];
  for (const raw of parseAll(OrderSchema, list.data.data)) {
    orders.push({
      number: raw.number,
      email: raw.email ?? null,
      state: orderState(raw),
      shipmentState: raw.fulfillment_status ?? null,
      completedAt: raw.completed_at ?? null,
      canceledAt: raw.canceled_at ?? null,
      items: parseAll(ItemSchema, raw.items).map(toItem),
      shipments: parseAll(FulfillmentSchema, raw.fulfillments).map(toShipment),
    });
  }
  return orders;
}

/** True when a list response has the `{ data: [] }` shape; used by "Test connection". */
export function isOrderList(body: unknown): boolean {
  return OrderListSchema.safeParse(body).success;
}
