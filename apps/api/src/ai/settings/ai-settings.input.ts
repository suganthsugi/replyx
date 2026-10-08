import { z } from 'zod';

/** Bodies of `PATCH /ai/settings` and `PUT /ai/settings/provider-key` (contracts/ai.yaml). */

const ModelId = z.string().min(1).max(100);

export const AiSettingsPatchSchema = z
  .object({
    replyMode: z.enum(['off', 'drafts', 'auto']).optional(),
    routingEnabled: z.boolean().optional(),
    routingThreshold: z.number().min(0.5).max(0.99).optional(),
    models: z.object({ fast: ModelId.optional(), standard: ModelId.optional(), advanced: ModelId.optional() }).strict().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Send at least one field' });

export type AiSettingsPatch = z.infer<typeof AiSettingsPatchSchema>;

export const ProviderKeyInputSchema = z.object({ apiKey: z.string().trim().min(8).max(200) }).strict();

export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;
