import { z } from 'zod';

/**
 * Request schemas of the routing-rule endpoints (contracts/operations.yaml `RoutingRule`). All are
 * `.strict()`; values are trimmed and normalised here, and the service then checks that the
 * group and tags exist.
 */

export const MAX_PHRASES = 20;
export const MAX_ID_LIST = 20;

const Phrase = z.string().trim().min(1).max(100);

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-cased, no leading `@`; matched exactly against the part of the email after the `@`. */
const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((domain) => domain.replace(/^@/, ''))
  .pipe(z.string().max(253).regex(DOMAIN));

const Priority = z.enum(['low', 'normal', 'high', 'urgent']);

const ConditionsSchema = z
  .object({
    messageContainsAny: z.array(Phrase).max(MAX_PHRASES).optional(),
    messageContainsAll: z.array(Phrase).max(MAX_PHRASES).optional(),
    customerTagIds: z.array(z.uuid()).max(MAX_ID_LIST).optional(),
    emailDomains: z.array(Domain).max(MAX_PHRASES).optional(),
  })
  .strict()
  // A rule without any condition would never match: at least one list must have an entry.
  .refine((conditions) => Object.values(conditions).some((list) => list.length > 0));

const ActionsSchema = z
  .object({
    groupId: z.uuid(),
    priority: Priority.optional(),
    tagIds: z.array(z.uuid()).max(MAX_ID_LIST).optional(),
  })
  .strict();

export const RoutingRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    conditions: ConditionsSchema,
    actions: ActionsSchema,
  })
  .strict();

export type RoutingRuleInput = z.infer<typeof RoutingRuleInputSchema>;

export const RoutingRuleIdParams = z.object({ id: z.uuid() }).strict();

export const RoutingRuleOrderSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .max(100)
      // An id listed twice would be ambiguous: reported as `invalid` on `ids`.
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

export const RoutingRuleTestSchema = z
  .object({
    message: z.string().min(1).max(10_000),
    customerId: z.uuid().optional(),
    customerEmail: z.email().max(254).optional(),
    customerTagIds: z.array(z.uuid()).max(MAX_ID_LIST).optional(),
  })
  .strict()
  // A real customer supplies the email and tags; mixing the two sources would be ambiguous.
  .refine((body) => body.customerId === undefined || (body.customerEmail === undefined && body.customerTagIds === undefined));

export type RoutingRuleTestInput = z.infer<typeof RoutingRuleTestSchema>;
