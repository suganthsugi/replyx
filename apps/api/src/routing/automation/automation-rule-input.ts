import { Duration } from 'luxon';
import { z } from 'zod';

import { isConditionGroup, type ConditionExpression } from '../../views/condition-schema.js';
import { validateConditions } from '../../views/view-compiler.js';

import type { AutomationActions, AutomationTrigger } from '../../platform-kernel/db/tables/routing.js';

/**
 * Request schemas of `/automation-rules` (contracts/operations.yaml `AutomationRule`, FR-088). All
 * `.strict()`. Conditions reuse the view condition tree and its validator (view-compiler.ts),
 * except `owner is me`, which means nothing without a viewer. The service then checks that the
 * referenced group, owner, tags and users exist.
 */

export const MAX_ID_LIST = 20;
/** Shortest and longest `time.elapsed` wait. */
const MIN_AFTER_MINUTES = 5;
const MAX_AFTER_DAYS = 90;

const States = ['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed'] as const;
const Priorities = ['low', 'normal', 'high', 'urgent'] as const;
const PENDING_STATES: ReadonlySet<string> = new Set(['pending_reminder', 'pending_close']);

const IsoAfter = z
  .string()
  .max(32)
  .refine((value) => {
    const duration = Duration.fromISO(value);
    if (!duration.isValid) return false;
    const minutes = duration.as('minutes');
    return minutes >= MIN_AFTER_MINUTES && minutes <= MAX_AFTER_DAYS * 24 * 60;
  }, { message: 'invalid_duration' });

const TriggerSchema = z.discriminatedUnion('event', [
  z.object({ event: z.enum(['ticket.created', 'ticket.updated', 'message.created']) }).strict(),
  z
    .object({
      event: z.literal('time.elapsed'),
      after: IsoAfter,
      since: z.enum(['created_at', 'updated_at', 'last_customer_message_at', 'last_agent_reply_at']),
    })
    .strict(),
]);

const ActionsSchema = z
  .object({
    groupId: z.uuid().nullable().optional(),
    ownerId: z.uuid().nullable().optional(),
    priority: z.enum(Priorities).optional(),
    state: z.enum(States).optional(),
    pendingInHours: z.int().min(1).max(720).optional(),
    addTagIds: z.array(z.uuid()).min(1).max(MAX_ID_LIST).optional(),
    autoReply: z.string().trim().min(1).max(10_000).optional(),
    notifyUserIds: z.array(z.uuid()).min(1).max(MAX_ID_LIST).optional(),
  })
  .strict()
  .refine((actions) => Object.keys(actions).some((key) => key !== 'pendingInHours'), { message: 'required' })
  .refine((actions) => actions.state === undefined || !PENDING_STATES.has(actions.state) || actions.pendingInHours !== undefined, {
    message: 'required',
    path: ['pendingInHours'],
  });

function usesOwnerMe(node: ConditionExpression): boolean {
  if (isConditionGroup(node)) return node.items.some(usesOwnerMe);
  if (node.field !== 'owner') return false;
  return Array.isArray(node.value) ? node.value.includes('me') : node.value === 'me';
}

const Conditions = z
  .unknown()
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return null;
    let tree: ConditionExpression;
    try {
      tree = validateConditions(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    if (usesOwnerMe(tree)) {
      ctx.addIssue({ code: 'custom', message: 'owner_me_not_allowed' });
      return z.NEVER;
    }
    return tree;
  });

export const AutomationRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    trigger: TriggerSchema,
    conditions: Conditions,
    actions: ActionsSchema,
  })
  .strict();

export type AutomationRuleInput = Omit<z.infer<typeof AutomationRuleInputSchema>, 'trigger' | 'actions'> & {
  trigger: AutomationTrigger;
  actions: AutomationActions;
};

export const AutomationRuleIdParams = z.object({ id: z.uuid() }).strict();
