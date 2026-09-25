import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * Ticket numbers (research D4): the tenant's `ticket_number` counter row, incremented in the
 * transaction that creates the ticket. The row lock serializes creation per tenant, so numbers
 * have no gaps or duplicates; a rollback gives the number back. Provisioning starts the counter
 * at 1000, so the first ticket is 1001.
 */
@Injectable()
export class TicketNumberService {
  async next(tx: TenantTransaction): Promise<number> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('TicketNumberService.next must run inside withTenant');
    return new CounterRepository(ctx).increment(tx, 'ticket_number');
  }
}

class CounterRepository extends TenantRepository {
  async increment(tx: TenantTransaction, name: string): Promise<number> {
    const row = await this.updateTable(tx, 'tenant_counters')
      .set({ value: sql`value + 1` })
      .where('name', '=', name)
      .returning('value')
      .executeTakeFirst();
    if (row === undefined) throw new Error(`Counter ${name} is missing for tenant ${this.ctx.tenantId}`);
    return Number(row.value);
  }
}
