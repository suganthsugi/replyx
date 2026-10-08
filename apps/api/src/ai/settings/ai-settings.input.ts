import { z } from 'zod';

/** Bodies of `PATCH /ai/settings` and `PUT /ai/settings/provider-key` (contracts/ai.yaml). */

const ModelId = z.string().min(1).max(100);

/** `routing_threshold` is numeric(3,2): two decimals at most, so the saved value is what was sent. */
const Threshold = z
  .number()
  .min(0.5)
  .max(0.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, { message: 'Use at most two decimals' });

export const AiSettingsPatchSchema = z
  .object({
    replyMode: z.enum(['off', 'drafts', 'auto']).optional(),
    routingEnabled: z.boolean().optional(),
    routingThreshold: Threshold.optional(),
    models: z.object({ fast: ModelId.optional(), standard: ModelId.optional(), advanced: ModelId.optional() }).strict().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Send at least one field' });

export type AiSettingsPatch = z.infer<typeof AiSettingsPatchSchema>;

export const ProviderKeyInputSchema = z.object({ apiKey: z.string().trim().min(8).max(200) }).strict();

export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;
