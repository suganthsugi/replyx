import { sql } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import { DEFAULT_THRESHOLDS, type ComplexityConfig, type ComplexityFactor, type ComplexityFacts } from './complexity-scorer.js';

import type { AiComplexityThresholds, ComplexityFactorDefinition } from '../../platform-kernel/db/tables/ai.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/** The factors seeded on the first enable (research R12), without the VIP one, which needs a tag. */
const DEFAULT_FACTORS: ComplexityFactor[] = [
  {
    key: 'frustration',
    label: 'Customer frustration',
    kind: 'score',
    weight: 2,
    instructions: "Rate the customer's frustration in their latest messages.",
    levels: ['calm', 'annoyed', 'angry'],
  },
  {
    key: 'several_issues',
    label: 'Several issues in one message',
    kind: 'noul',
    weight: 1,
    instructions: 'Decide whether the customer raises more than one separate problem or question.',
    criteria: { true: 'The customer raises two or more separate problems or questions.', false: 'The customer raises one problem or question.' },
  },
  {
    key: 'technical_problem',
    label: 'Technical problem',
    kind: 'noul',
    weight: 1,
    instructions: 'Decide whether the customer reports a technical problem with a product, the website or an account.',
    criteria: { true: 'Something does not work: an error, a crash, a failed payment, a login or setup problem.', false: 'No technical problem is reported.' },
  },
];

const VIP_TAG = 'vip';

/** `ai_complexity_factors` plus the thresholds on `ai_settings` (data-model.md). */
export class ComplexityRepository extends TenantRepository {
  async config(tx: TenantTransaction): Promise<ComplexityConfig> {
    const settings = await this.selectFrom(tx, 'ai_settings').select('ai_settings.complexity_thresholds').executeTakeFirst();
    const rows = await this.selectFrom(tx, 'ai_complexity_factors')
      .select(['ai_complexity_factors.key', 'ai_complexity_factors.label', 'ai_complexity_factors.kind', 'ai_complexity_factors.weight', 'ai_complexity_factors.definition'])
      .orderBy('ai_complexity_factors.position')
      .execute();
    return {
      thresholds: settings?.complexity_thresholds ?? DEFAULT_THRESHOLDS,
      factors: rows.map((row) => ({ key: row.key, label: row.label, kind: row.kind, weight: Number(row.weight), ...row.definition }) as ComplexityFactor),
    };
  }

  async hasFactors(tx: TenantTransaction): Promise<boolean> {
    return (await this.selectFrom(tx, 'ai_complexity_factors').select('ai_complexity_factors.id').limit(1).executeTakeFirst()) !== undefined;
  }

  /** Replaces every factor (the caller holds the `ai_settings` row lock, so two saves never interleave). */
  async replace(tx: TenantTransaction, factors: readonly ComplexityFactor[]): Promise<void> {
    await this.deleteFrom(tx, 'ai_complexity_factors').execute();
    if (factors.length === 0) return;
    await this.insertInto(
      tx,
      'ai_complexity_factors',
      factors.map((factor, position) => {
        const { key, label, kind, weight, ...definition } = factor;
        return { position, key, label, kind, weight, definition: JSON.stringify(definition satisfies ComplexityFactorDefinition) };
      }),
    ).execute();
  }

  async setThresholds(tx: TenantTransaction, thresholds: AiComplexityThresholds): Promise<void> {
    await this.updateTable(tx, 'ai_settings').set({ complexity_thresholds: JSON.stringify(thresholds) }).execute();
  }

  async tagExists(tx: TenantTransaction, tagId: string): Promise<boolean> {
    return (await this.selectFrom(tx, 'tags').select('tags.id').where('tags.id', '=', tagId).executeTakeFirst()) !== undefined;
  }

  /** Seeds the default factors when the tenant has none yet; the VIP factor only if a "VIP" tag exists. */
  async seedDefaults(tx: TenantTransaction): Promise<boolean> {
    if (await this.hasFactors(tx)) return false;
    const vip = await this.selectFrom(tx, 'tags').select('tags.id').where(sql<string>`lower(tags.name)`, '=', VIP_TAG).executeTakeFirst();
    const factors: ComplexityFactor[] = [...DEFAULT_FACTORS];
    if (vip !== undefined) factors.push({ key: 'vip_customer', label: 'VIP customer', kind: 'customer_tag', weight: 1, tagId: vip.id });
    await this.replace(tx, factors);
    return true;
  }

  /** What the database knows for the `customer_tag`, `reopen_count` and `sla_breached` factors. */
  async facts(tx: TenantTransaction, ticketId: string, customerId: string): Promise<ComplexityFacts> {
    const tags = await this.selectFrom(tx, 'customer_tags').select('customer_tags.tag_id').where('customer_tags.user_id', '=', customerId).execute();
    const reopens = await this.selectFrom(tx, 'ticket_history')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ticket_history.ticket_id', '=', ticketId)
      .where('ticket_history.field', '=', 'state')
      .where(sql<boolean>`ticket_history.old_value #>> '{}' IN ('resolved', 'closed')`)
      .where(sql<boolean>`ticket_history.new_value #>> '{}' = 'open'`)
      .executeTakeFirstOrThrow();
    const sla = await this.selectFrom(tx, 'ticket_sla').select('ticket_sla.status').where('ticket_sla.ticket_id', '=', ticketId).executeTakeFirst();
    return { customerTagIds: new Set(tags.map((tag) => tag.tag_id)), reopenCount: Number(reopens.count), slaBreached: sla?.status === 'breached' };
  }
}
