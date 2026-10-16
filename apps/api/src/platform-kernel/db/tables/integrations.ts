import type { Generated, GeneratedTimestamp, Timestamp } from './column-types.js';

/** Migration 0022_webhooks (data-model.md "webhooks", "webhook_deliveries", research D16). */

export const WEBHOOK_EVENTS = ['ticket.created', 'ticket.updated', 'message.created', 'ticket.assigned', 'ticket.closed'] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'gave_up';

export interface WebhooksTable {
  id: Generated<string>;
  tenant_id: string;
  url: string;
  /** Sealed with `SecretBox`; opened only by the delivery job. */
  secret_encrypted: string;
  events: WebhookEvent[];
  enabled: Generated<boolean>;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  tenant_id: string;
  webhook_id: string;
  event_id: string;
  event_type: WebhookEvent;
  /** 1–8. */
  attempt: number;
  status: Generated<WebhookDeliveryStatus>;
  /** The exact request body (text, never re-serialized), the same for every attempt of the event. */
  body: string;
  response_code: number | null;
  duration_ms: number | null;
  error: string | null;
  /** When a `pending` attempt is due; on a `failed` attempt, when the next one is. */
  next_attempt_at: Timestamp | null;
  attempted_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface IntegrationTables {
  webhooks: WebhooksTable;
  webhook_deliveries: WebhookDeliveriesTable;
}
