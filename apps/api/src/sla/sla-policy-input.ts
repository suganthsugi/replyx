import { z } from 'zod';

import { ConditionExpressionSchema, isConditionGroup, type ConditionGroup } from '../views/condition-schema.js';

/**
 * Request schema of the SLA policy endpoints (contracts/operations.yaml `SlaPolicy`). `.strict()`;
 * the service checks the condition tree (`validatePolicyConditions`), the calendar and the groups.
 *
 * - `conditions` is a `ConditionGroup` (at least one item), limited to what policy matching
 *   evaluates (policy-matching.ts): `priority` and `group` with `is` / `is_not`.
 * - Each target is optional or null (not tracked); minutes are whole numbers of business minutes.
 * - `warningPercent` is 50-99 and defaults to 80.
 * - `position` orders policies (the first match wins); omitted on create it goes last, omitted on
 *   update it stays. Ties break on id.
 */

export const MAX_TARGET_MINUTES = 525_600; // one year of minutes

const RootConditions = ConditionExpressionSchema.refine((node): node is ConditionGroup => isConditionGroup(node));

const Minutes = z.int().min(1).max(MAX_TARGET_MINUTES).nullable().optional();

export const SlaPolicyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    position: z.int().min(0).max(100_000).optional(),
    conditions: RootConditions,
    businessHoursId: z.uuid(),
    firstResponseMinutes: Minutes,
    nextResponseMinutes: Minutes,
    resolutionMinutes: Minutes,
    warningPercent: z.int().min(50).max(99).default(80),
  })
  .strict();

export type SlaPolicyInput = z.infer<typeof SlaPolicyInputSchema>;
