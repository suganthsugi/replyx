import { z } from 'zod';

import type { CommerceOrder, CommerceOrderItem, CommerceShipment } from '../ports.js';

/**
 * The one place that knows Spree 5.5's Admin API v3 order shape (specs/002-ai-assist research R9).
 * Everything is tolerant: unknown fields are ignored, missing optional fields become null, and an
 * association that came back as bare ids (not expanded) is skipped instead of failing the lookup.
 *
 * Sources: the Admin API docs (`/api/v3/admin/orders`, expand keys `items` and `fulfillments`) and
 * the v3 Store SDK types (line item `name`/`quantity`/`options_text`, fulfillment
 * `tracking`/`tracking_url`/`status`). Names marked UNCONFIRMED have not been checked against a live
 * 5.5.4 store; the legacy v2 spellings are accepted as fallbacks so either shape maps.
 */

/** Expand keys sent with the order query. UNCONFIRMED against the live store (docs: `items`, `fulfillments`). */
export const SPREE_ORDER_EXPAND = 'items,fulfillments';

const Text = z.string().nullish();

const ItemSchema = z.object({ name: Text, quantity: z.number().nullish(), options_text: Text }).loose();

const FulfillmentSchema = z
  .object({
    tracking: Text,
    tracking_url: Text,
    /** v3 `status`; `state` is the v2 spelling (UNCONFIRMED which the Admin API uses). */
    status: Text,
    state: Text,
  })
  .loose();

const OrderSchema = z
  .object({
    number: z.string().min(1),
    email: Text,
    /** v3 5.5 `status`; `state` is the legacy field (removed in Spree 6). */
    status: Text,
    state: Text,
    /** v3 `fulfillment_status`; `shipment_state` is the v2 spelling. */
    fulfillment_status: Text,
    shipment_state: Text,
    completed_at: Text,
    canceled_at: Text,
    /** v3 `items`; `line_items` is the v2 spelling (UNCONFIRMED which the Admin API expands). */
    items: z.array(z.unknown()).nullish(),
    line_items: z.array(z.unknown()).nullish(),
    /** v3 `fulfillments`; `shipments` is the v2 spelling. */
    fulfillments: z.array(z.unknown()).nullish(),
    shipments: z.array(z.unknown()).nullish(),
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
  return { name: raw.name ?? '', quantity: raw.quantity ?? null, options: raw.options_text ?? null };
}

function toShipment(raw: z.infer<typeof FulfillmentSchema>): CommerceShipment {
  return { tracking: raw.tracking ?? null, trackingUrl: raw.tracking_url ?? null, state: raw.status ?? raw.state ?? null };
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
      state: raw.status ?? raw.state ?? null,
      shipmentState: raw.fulfillment_status ?? raw.shipment_state ?? null,
      completedAt: raw.completed_at ?? null,
      canceledAt: raw.canceled_at ?? null,
      items: parseAll(ItemSchema, raw.items ?? raw.line_items).map(toItem),
      shipments: parseAll(FulfillmentSchema, raw.fulfillments ?? raw.shipments).map(toShipment),
    });
  }
  return orders;
}

/** True when a list response has the `{ data: [] }` shape; used by "Test connection". */
export function isOrderList(body: unknown): boolean {
  return OrderListSchema.safeParse(body).success;
}
