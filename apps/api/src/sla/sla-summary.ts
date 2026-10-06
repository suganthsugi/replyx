import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { SlaStatus, SlaTarget } from '../platform-kernel/db/tables/sla.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

/**
 * The SLA part of a staff ticket response (contracts/tickets.yaml `SlaSummary`, FR-085): status,
 * the matching policy's name and the earliest running target's due time. Built from `ticket_sla`
 * for a set of tickets in ONE query (no N+1 on lists). Staff-only: customer responses and events
 * never carry it.
 */

export interface SlaSummaryDto {
  status: 'none' | SlaStatus;
  policyName?: string;
  nextDueAt?: string | null;
  target?: SlaTarget;
}

export const NO_SLA: SlaSummaryDto = { status: 'none' };

interface DueCandidate {
  target: SlaTarget;
  dueAt: Date | null;
}

/** The earliest due time among the targets that run now; a paused resolution timer does not run. */
export function nextDue(candidates: readonly DueCandidate[]): { target: SlaTarget; dueAt: Date } | undefined {
  let best: { target: SlaTarget; dueAt: Date } | undefined;
  for (const { target, dueAt } of candidates) {
    if (dueAt === null) continue;
    if (best === undefined || dueAt.getTime() < best.dueAt.getTime()) best = { target, dueAt };
  }
  return best;
}

export class SlaSummaryRepository extends TenantRepository {
  /** Tickets without a `ticket_sla` row are absent from the map (read them as `NO_SLA`). */
  async byTicketIds(tx: TenantTransaction, ticketIds: readonly string[]): Promise<Map<string, SlaSummaryDto>> {
    const result = new Map<string, SlaSummaryDto>();
    if (ticketIds.length === 0) return result;
    const rows = await this.selectFrom(tx, 'ticket_sla')
      .innerJoin('sla_policies', (join) =>
        join.onRef('sla_policies.tenant_id', '=', 'ticket_sla.tenant_id').onRef('sla_policies.id', '=', 'ticket_sla.policy_id'),
      )
      .select([
        'ticket_sla.ticket_id',
        'ticket_sla.status',
        'ticket_sla.paused_since',
        'ticket_sla.first_response_due_at',
        'ticket_sla.next_response_due_at',
        'ticket_sla.resolution_due_at',
        'sla_policies.name as policy_name',
      ])
      .where('ticket_sla.ticket_id', 'in', [...ticketIds])
      .execute();
    for (const row of rows) {
      const due = nextDue([
        { target: 'first_response', dueAt: row.first_response_due_at },
        { target: 'next_response', dueAt: row.next_response_due_at },
        { target: 'resolution', dueAt: row.paused_since === null ? row.resolution_due_at : null },
      ]);
      result.set(row.ticket_id, {
        status: row.status,
        policyName: row.policy_name,
        nextDueAt: due?.dueAt.toISOString() ?? null,
        ...(due === undefined ? {} : { target: due.target }),
      });
    }
    return result;
  }
}
