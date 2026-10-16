import { z } from 'zod';

import { WEBHOOK_EVENTS } from '../../platform-kernel/db/tables/integrations.js';
import { paginationQuery } from '../../platform-kernel/http/pagination.js';

/**
 * Request schemas of `/webhooks*` (contracts/operations.yaml `WebhookInput`, FR-090). All
 * `.strict()`. Whether the URL may be called (https, not a private address) is checked by the
 * service with the outbound guard, so the admin gets a field error on save; the delivery job
 * checks again at send time.
 */

export const WebhookInputSchema = z
  .object({
    url: z.string().trim().min(1).max(2000),
    events: z
      .array(z.enum(WEBHOOK_EVENTS))
      .min(1)
      .max(WEBHOOK_EVENTS.length)
      .transform((events) => [...new Set(events)]),
    enabled: z.boolean(),
  })
  .strict();

export type WebhookInput = z.infer<typeof WebhookInputSchema>;

export const WebhookIdParams = z.object({ id: z.uuid() }).strict();

export const DeliveriesQuery = z.object(paginationQuery).strict();
