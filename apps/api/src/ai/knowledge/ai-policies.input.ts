import { z } from 'zod';

/** Bodies of the policy endpoints (contracts/ai.yaml `PolicyDocumentInput`, `PolicyVersionInput`). */

export const IdParamsSchema = z.object({ id: z.uuid() }).strict();

const Title = z.string().trim().min(1).max(200);
const Text = z.string().min(1).max(200_000);

/** Exactly one of `text` and `attachmentId`. */
function exactlyOneSource(input: { text?: string | undefined; attachmentId?: string | undefined }): boolean {
  return (input.text === undefined) !== (input.attachmentId === undefined);
}

const sourceProblem = { message: 'Send exactly one of text or attachmentId', path: ['text'] };

export const PolicyVersionInputSchema = z
  .object({ text: Text.optional(), attachmentId: z.uuid().optional() })
  .strict()
  .refine(exactlyOneSource, sourceProblem);

export type PolicyVersionInput = z.infer<typeof PolicyVersionInputSchema>;

export const PolicyDocumentInputSchema = z
  .object({ title: Title, text: Text.optional(), attachmentId: z.uuid().optional() })
  .strict()
  .refine(exactlyOneSource, sourceProblem);

export type PolicyDocumentInput = z.infer<typeof PolicyDocumentInputSchema>;

export const PolicyRenameSchema = z.object({ title: Title }).strict();

export type PolicyRename = z.infer<typeof PolicyRenameSchema>;
