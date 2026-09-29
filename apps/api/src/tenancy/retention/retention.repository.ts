import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/**
 * Data access for the retention purge (T193, research D18). Every query goes through the
 * tenant-scoped helpers; the purge itself runs as `replyx_app`, because the ticket foreign keys
 * cascade to messages, attachments, history, tags and notifications outside the app role's grants.
 */

export interface PurgeCandidate {
  id: string;
  groupId: string | null;
}

export interface BatchCounts {
  messages: number;
  attachments: number;
  history: number;
  links: number;
  tags: number;
}

const inIds = (ids: readonly string[]) => [...ids];

export class RetentionRepository extends TenantRepository {
  async settings(tx: TenantTransaction): Promise<{ retentionPeriod: string; auditRetention: string; timezone: string }> {
    const row = await this.selectFrom(tx, 'tenant_settings')
      .select(['tenant_settings.retention_period', 'tenant_settings.audit_retention', 'tenant_settings.timezone'])
      .executeTakeFirstOrThrow();
    return { retentionPeriod: row.retention_period, auditRetention: row.audit_retention, timezone: row.timezone };
  }

  /** Closed tickets whose closure is older than `cutoff` (FR-005a: never a ticket that is not closed). */
  async countPurgeable(tx: TenantTransaction, cutoff: Date): Promise<number> {
    const row = await this.selectFrom(tx, 'tickets')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tickets.state', '=', 'closed')
      .where('tickets.closed_at', '<', cutoff)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * One batch, locked so a concurrent purge skips it and a reopening ticket waits. State and age
   * are checked here, under the lock, not only when the batch was counted.
   */
  async lockBatch(tx: TenantTransaction, cutoff: Date, limit: number): Promise<PurgeCandidate[]> {
    const rows = await this.selectFrom(tx, 'tickets')
      .select(['tickets.id', 'tickets.group_id'])
      .where('tickets.state', '=', 'closed')
      .where('tickets.closed_at', '<', cutoff)
      .orderBy('tickets.closed_at')
      .orderBy('tickets.id')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    return rows.map((row) => ({ id: row.id, groupId: row.group_id }));
  }

  /** What the batch will take with it, counted before the delete cascades (counts go to the audit entry). */
  async countRelated(tx: TenantTransaction, ids: readonly string[]): Promise<BatchCounts> {
    const messages = await this.selectFrom(tx, 'ticket_messages')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('ticket_messages.ticket_id', 'in', inIds(ids))
      .executeTakeFirstOrThrow();
    const history = await this.selectFrom(tx, 'ticket_history')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('ticket_history.ticket_id', 'in', inIds(ids))
      .executeTakeFirstOrThrow();
    const tags = await this.selectFrom(tx, 'ticket_tags')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('ticket_tags.ticket_id', 'in', inIds(ids))
      .executeTakeFirstOrThrow();
    const links = await this.selectFrom(tx, 'ticket_links')
      .select((eb) => eb.fn.countAll().as('count'))
      .where((eb) => eb.or([eb('ticket_links.from_ticket_id', 'in', inIds(ids)), eb('ticket_links.to_ticket_id', 'in', inIds(ids))]))
      .executeTakeFirstOrThrow();
    const attachments = await this.attachmentIds(tx, ids);
    return {
      messages: Number(messages.count),
      attachments: attachments.length,
      history: Number(history.count),
      links: Number(links.count),
      tags: Number(tags.count),
    };
  }

  /** Attachments sent with the batch's messages; their files go before their rows. */
  async attachmentIds(tx: TenantTransaction, ids: readonly string[]): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'attachments')
      .innerJoin('ticket_messages', (join) =>
        join
          .onRef('ticket_messages.tenant_id', '=', 'attachments.tenant_id')
          .onRef('ticket_messages.id', '=', 'attachments.message_id'),
      )
      .select('attachments.id')
      .where('ticket_messages.ticket_id', 'in', inIds(ids))
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Links owned by a purged ticket go with it. Links from a surviving ticket to a purged one keep
   * a tombstone (`to_ticket_id NULL`, `removed_reason 'retention'`) so the survivor can show that
   * its linked ticket was removed. The FK's own `ON DELETE SET NULL` would leave `removed_reason`
   * unset and violate `ticket_links_tombstone`, so both steps are explicit and run before the delete.
   */
  async retireLinks(tx: TenantTransaction, ids: readonly string[]): Promise<void> {
    await this.deleteFrom(tx, 'ticket_links').where('ticket_links.from_ticket_id', 'in', inIds(ids)).execute();
    await this.updateTable(tx, 'ticket_links')
      .set({ to_ticket_id: null, removed_reason: 'retention' })
      .where('ticket_links.to_ticket_id', 'in', inIds(ids))
      .execute();
  }

  /** Cascades to messages, attachments, history, tags and notifications (migration 0008/0009/0010). */
  async deleteTickets(tx: TenantTransaction, ids: readonly string[]): Promise<void> {
    await this.deleteFrom(tx, 'tickets').where('tickets.id', 'in', inIds(ids)).execute();
  }
}
