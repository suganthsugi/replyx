import { z } from 'zod';

/** Body of `PUT /ai/store-connection` (contracts/ai.yaml). */
export const StoreConnectionInputSchema = z
  .object({
    kind: z.enum(['spree']),
    baseUrl: z.string().trim().min(1).max(300),
    /** Required when creating; omit to keep the saved key. */
    apiKey: z.string().trim().min(8).max(200).optional(),
  })
  .strict();

export type StoreConnectionInput = z.infer<typeof StoreConnectionInputSchema>;
