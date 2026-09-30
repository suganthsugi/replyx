import { z } from 'zod';

import { ConditionExpressionSchema, isConditionGroup, type ConditionGroup } from './condition-schema.js';

/**
 * The body of `POST /views` and `PUT /views/{id}` (contracts/tickets.yaml `ViewInput`), and the
 * allowed sort fields and columns. The lists mirror the contract enums; the default views'
 * `sort`/`columns` (default-views.contributor.ts) are drawn from them.
 */

export const VIEW_SORT_FIELDS = ['updated_at', 'created_at', 'priority', 'last_customer_message_at', 'sla_due_at', 'number'] as const;
export const VIEW_COLUMNS = [
  'number',
  'title',
  'customer',
  'state',
  'priority',
  'group',
  'owner',
  'tags',
  'waiting_on',
  'sla',
  'updated_at',
  'created_at',
  'last_customer_message_at',
] as const;
export const VIEW_VISIBILITIES = ['personal', 'all_staff', 'roles', 'groups'] as const;

const MAX_SORT_ITEMS = 3;
const MAX_SHARED_IDS = 100;

/** A condition tree whose root is a group (`ConditionGroup`); the semantic pass is `validateConditions`. */
const RootConditions = ConditionExpressionSchema.refine((node): node is ConditionGroup => isConditionGroup(node));

const hasUnique = (values: readonly string[]) => new Set(values).size === values.length;

export const ViewInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(300).optional(),
    visibility: z.enum(VIEW_VISIBILITIES),
    sharedRoleIds: z.array(z.uuid()).max(MAX_SHARED_IDS).optional(),
    sharedGroupIds: z.array(z.uuid()).max(MAX_SHARED_IDS).optional(),
    conditions: RootConditions,
    sort: z
      .array(z.object({ field: z.enum(VIEW_SORT_FIELDS), direction: z.enum(['asc', 'desc']) }).strict())
      .max(MAX_SORT_ITEMS)
      // A field listed twice would be ambiguous: reported as `invalid` on `sort`.
      .refine((items) => hasUnique(items.map((item) => item.field))),
    columns: z
      .array(z.enum(VIEW_COLUMNS))
      .max(VIEW_COLUMNS.length)
      .refine((items) => hasUnique(items)),
  })
  .strict();

export type ViewInput = z.infer<typeof ViewInputSchema>;

/** `POST /views/preview-count`: the unsaved tree, counted for the caller. */
export const PreviewCountSchema = z.object({ conditions: RootConditions }).strict();
