import { z } from 'zod';

/**
 * The bodies of `POST /macros`, `PUT /macros/{id}` and `POST /tickets/{id}/apply-macro`
 * (contracts/tickets.yaml `MacroInput`). Cross-field rules (a pending state needs
 * `pendingInHours`, roles/groups need ids, the macro must do something) are checked by the
 * service so they answer 400 `VALIDATION_FAILED` with a path, like views.
 */

export const MACRO_BODY_MAX = 10_000;
const MAX_SHARED_IDS = 100;
const MAX_TAGS = 20;
const MAX_PENDING_HOURS = 24 * 365;

export const MACRO_VISIBILITIES = ['all_staff', 'roles', 'groups'] as const;

const MacroActionsSchema = z
  .object({
    state: z.enum(['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed']).optional(),
    pendingInHours: z.number().int().min(1).max(MAX_PENDING_HOURS).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    addTagIds: z.array(z.uuid()).max(MAX_TAGS).optional(),
    assignToMe: z.boolean().optional(),
  })
  .strict();

export const MacroInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    body: z.string().max(MACRO_BODY_MAX),
    actions: MacroActionsSchema.default({}),
    visibility: z.enum(MACRO_VISIBILITIES).default('all_staff'),
    sharedRoleIds: z.array(z.uuid()).max(MAX_SHARED_IDS).optional(),
    sharedGroupIds: z.array(z.uuid()).max(MAX_SHARED_IDS).optional(),
  })
  .strict();

export type MacroInput = z.infer<typeof MacroInputSchema>;

export const MacroIdParams = z.object({ id: z.uuid() }).strict();

export const ApplyMacroSchema = z
  .object({
    macroId: z.uuid(),
    clientMessageId: z.uuid(),
    bodyOverride: z.string().max(MACRO_BODY_MAX).optional(),
  })
  .strict();

export type ApplyMacroInput = z.infer<typeof ApplyMacroSchema>;
