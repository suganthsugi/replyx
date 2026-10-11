import { sql } from 'kysely';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { JsonValue } from '../../platform-kernel/db/tables/column-types.js';
import type { AutomationActions, AutomationEvent, AutomationTrigger } from '../../platform-kernel/db/tables/routing.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/** Automation rules and their run ledger (migration 0021, data-model.md "automation_rules"). */

export interface AutomationRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  trigger: AutomationTrigger;
  conditions: JsonValue | null;
  actions: AutomationActions;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationRuleValues {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: JsonValue | null;
  actions: AutomationActions;
}

const COLUMNS = [
  'automation_rules.id',
  'automation_rules.name',
  'automation_rules.enabled',
  'automation_rules.position',
  'automation_rules.trigger',
  'automation_rules.conditions',
  'automation_rules.actions',
  'automation_rules.created_at',
  'automation_rules.updated_at',
] as const;

type Raw = {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  trigger: AutomationTrigger;
  conditions: JsonValue | null;
  actions: AutomationActions;
  created_at: Date;
  updated_at: Date;
};

function toRow(raw: Raw): AutomationRuleRow {
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled,
    position: raw.position,
    trigger: raw.trigger,
    conditions: raw.conditions,
    actions: raw.actions,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

const json = (value: unknown) => JSON.stringify(value);

export class AutomationRulesRepository extends TenantRepository {
  async all(tx: TenantTransaction): Promise<AutomationRuleRow[]> {
    const rows = await this.selectFrom(tx, 'automation_rules').select(COLUMNS).orderBy('automation_rules.position').orderBy('automation_rules.id').execute();
    return rows.map(toRow);
  }

  /** Enabled rules for one trigger event, in order. */
  async enabledFor(tx: TenantTransaction, event: AutomationEvent): Promise<AutomationRuleRow[]> {
    const rows = await this.selectFrom(tx, 'automation_rules')
      .select(COLUMNS)
      .where('automation_rules.enabled', '=', true)
      .where(sql<boolean>`automation_rules.trigger ->> 'event' = ${event}`)
      .orderBy('automation_rules.position')
      .orderBy('automation_rules.id')
      .execute();
    return rows.map(toRow);
  }

  async byId(tx: TenantTransaction, id: string): Promise<AutomationRuleRow | undefined> {
    const row = await this.selectFrom(tx, 'automation_rules').select(COLUMNS).where('automation_rules.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  async names(tx: TenantTransaction, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'automation_rules').select(['automation_rules.id', 'automation_rules.name']).where('automation_rules.id', 'in', unique).execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** Serializes writes to one tenant's rule list until the transaction ends. */
  async lockRules(tx: TenantTransaction): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automation_rules:${this.ctx.tenantId}`}, 0))`.execute(tx);
  }

  async count(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'automation_rules').select(sql<string>`count(*)`.as('count')).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async nextPosition(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'automation_rules').select(sql<number | null>`max(automation_rules.position)`.as('max')).executeTakeFirstOrThrow();
    return row.max === null ? 0 : Number(row.max) + 1;
  }

  async insert(tx: TenantTransaction, values: AutomationRuleValues, position: number): Promise<string> {
    const row = await this.insertInto(tx, 'automation_rules', {
      name: values.name,
      enabled: values.enabled,
      position,
      trigger: json(values.trigger),
      conditions: values.conditions === null ? null : json(values.conditions),
      actions: json(values.actions),
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(tx: TenantTransaction, id: string, values: AutomationRuleValues): Promise<void> {
    await this.updateTable(tx, 'automation_rules')
      .set({
        name: values.name,
        enabled: values.enabled,
        trigger: json(values.trigger),
        conditions: values.conditions === null ? null : json(values.conditions),
        actions: json(values.actions),
      })
      .where('automation_rules.id', '=', id)
      .execute();
  }

  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'automation_rules').where('automation_rules.id', '=', id).execute();
  }

  /** Whether this rule already ran (or failed) for this ticket and trigger key. */
  async hasRun(tx: TenantTransaction, ruleId: string, ticketId: string, triggerKey: string): Promise<boolean> {
    const row = await this.selectFrom(tx, 'automation_runs')
      .select('automation_runs.id')
      .where('automation_runs.rule_id', '=', ruleId)
      .where('automation_runs.ticket_id', '=', ticketId)
      .where('automation_runs.trigger_key', '=', triggerKey)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Records a run; false when one already exists (another worker got there first). */
  async recordRun(tx: TenantTransaction, run: { ruleId: string; ticketId: string; triggerKey: string; status: 'done' | 'failed'; error?: string }): Promise<boolean> {
    const row = await this.insertInto(tx, 'automation_runs', {
      rule_id: run.ruleId,
      ticket_id: run.ticketId,
      trigger_key: run.triggerKey,
      status: run.status,
      error: run.error?.slice(0, 200) ?? null,
    })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }
}
