import { sql } from 'kysely';

import { RoutingRulesRepository } from './rule-evaluator.service.js';

import type { RoutingActions, RoutingConditions } from '../platform-kernel/db/tables/routing.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

export interface RoutingRuleRow {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  actions: RoutingActions;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutingRuleValues {
  name: string;
  enabled: boolean;
  conditions: RoutingConditions;
  actions: RoutingActions;
}

const COLUMNS = [
  'routing_rules.id',
  'routing_rules.name',
  'routing_rules.position',
  'routing_rules.enabled',
  'routing_rules.conditions',
  'routing_rules.actions',
  'routing_rules.created_at',
  'routing_rules.updated_at',
] as const;

/** CRUD on top of the evaluator's read queries. Every query is tenant-scoped by the base class. */
export class RoutingRuleWritesRepository extends RoutingRulesRepository {
  /**
   * Serializes writes of one tenant's rule list (create, delete, reorder), so positions stay a
   * gap-free 0..n-1 sequence and the 100-rule limit cannot be raced. Released at commit.
   */
  async lockRules(tx: TenantTransaction): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`routing_rules:${this.ctx.tenantId}`}))`.execute(tx);
  }

  async all(tx: TenantTransaction): Promise<RoutingRuleRow[]> {
    const rows = await this.selectFrom(tx, 'routing_rules').select(COLUMNS).orderBy('routing_rules.position').orderBy('routing_rules.id').execute();
    return rows.map(toRow);
  }

  async byId(tx: TenantTransaction, id: string): Promise<RoutingRuleRow | undefined> {
    const row = await this.selectFrom(tx, 'routing_rules').select(COLUMNS).where('routing_rules.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toRow(row);
  }

  async count(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'routing_rules').select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    return Number(row.total);
  }

  /** The next position after the current last one (0 for the first rule). */
  async nextPosition(tx: TenantTransaction): Promise<number> {
    const row = await this.selectFrom(tx, 'routing_rules').select((eb) => eb.fn.max('routing_rules.position').as('last')).executeTakeFirstOrThrow();
    return row.last === null ? 0 : Number(row.last) + 1;
  }

  async insert(tx: TenantTransaction, values: RoutingRuleValues, position: number): Promise<string> {
    const row = await this.insertInto(tx, 'routing_rules', {
      name: values.name,
      enabled: values.enabled,
      position,
      conditions: JSON.stringify(values.conditions),
      actions: JSON.stringify(values.actions),
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(tx: TenantTransaction, id: string, values: RoutingRuleValues): Promise<void> {
    await this.updateTable(tx, 'routing_rules')
      .set({
        name: values.name,
        enabled: values.enabled,
        conditions: JSON.stringify(values.conditions),
        actions: JSON.stringify(values.actions),
      })
      .where('routing_rules.id', '=', id)
      .execute();
  }

  async delete(tx: TenantTransaction, id: string): Promise<void> {
    await this.deleteFrom(tx, 'routing_rules').where('routing_rules.id', '=', id).execute();
  }

  /** Position = index in `ids`. */
  async setPositions(tx: TenantTransaction, ids: readonly string[]): Promise<void> {
    for (const [position, id] of ids.entries()) {
      await this.updateTable(tx, 'routing_rules').set({ position }).where('routing_rules.id', '=', id).execute();
    }
  }

  /** A customer of this tenant (any status): the dry run borrows their email and tags. */
  customer(tx: TenantTransaction, userId: string): Promise<{ id: string; email: string } | undefined> {
    return this.selectFrom(tx, 'users')
      .select(['users.id', 'users.email'])
      .where('users.id', '=', userId)
      .where('users.kind', '=', 'customer')
      .executeTakeFirst();
  }
}

function toRow(row: {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  actions: RoutingActions;
  created_at: Date;
  updated_at: Date;
}): RoutingRuleRow {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    conditions: row.conditions,
    actions: row.actions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
