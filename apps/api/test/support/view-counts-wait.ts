import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';

import { PLATFORM_DB, type Database } from '../../src/platform-kernel/db/database.js';

import { getTestApp } from './app.js';

/** Waits until the worker's view-counts consumer has processed every event of the tenant it handles. */
export async function awaitViewCountsConsumed(tenantId: string): Promise<void> {
  const { app } = await getTestApp();
  const platformDb = app.get<Kysely<Database>>(PLATFORM_DB);
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ pending: string }>`
        SELECT count(*) AS pending FROM outbox_events e
        WHERE e.tenant_id = ${tenantId}
          AND e.type IN ('ticket.created', 'ticket.updated', 'ticket.removed_from_view', 'access.changed', 'sla.warning', 'sla.breached', 'sla.updated')
          AND NOT EXISTS (SELECT 1 FROM processed_events p WHERE p.consumer = 'view-counts' AND p.event_id = e.id)
      `.execute(platformDb);
      if (Number(rows[0]?.pending ?? 0) !== 0) throw new Error('view-counts consumer has not caught up');
    },
    { timeout: 60_000, interval: 200 },
  );
}
