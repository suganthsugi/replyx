import { Injectable } from '@nestjs/common';

import { decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { TenantRepository, type TenantInsert } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';

import { TicketsRepository } from './tickets.repository.js';

import type { TicketLinkDto } from './ticket-dto.js';
import type { TicketLinkKind } from '../platform-kernel/db/tables/tickets.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Ticket links (contracts/tickets.yaml `/tickets/{id}/links*`, data-model.md "ticket_links",
 * FR-042 area). Creating or removing a link needs edit on this ticket's group; creating one also
 * needs view on the other ticket's group (an invisible or unknown target is 404, same as a
 * missing ticket, constitution I). The unique `(tenant_id, from, to, kind)` constraint
 * (migration 0008) makes a repeated link 409 `LINK_ALREADY_EXISTS` instead of a duplicate row.
 */

export interface LinkInput {
  targetTicketId: string;
  kind: TicketLinkKind;
}

const SUPPORT = 'support' as const;
type Viewer = EffectiveAccess | typeof SUPPORT;

function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

/** Throws 404 when the ticket is invisible and 403 when the caller may not edit it. */
function requireEdit(access: Viewer, groupId: string | null): void {
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, 'ticket.edit', { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound('ticket');
  if (decision === 'deny') throw permissionDenied();
}

@Injectable()
export class TicketLinksService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
  ) {}

  async create(ctx: TenantContext, ticketId: string, input: LinkInput): Promise<TicketLinkDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const tickets = new TicketsRepository(ctx);
      const from = await tickets.find(tx, ticketId);
      if (from === undefined || !canView(access, from.group_id)) throw notFound('ticket');
      requireEdit(access, from.group_id);

      if (input.targetTicketId === ticketId) throw conflict('SAME_TICKET', 'A ticket cannot link to itself');

      const to = await tickets.find(tx, input.targetTicketId);
      if (to === undefined || !canView(access, to.group_id)) throw notFound('ticket');

      const links = new TicketLinksRepository(ctx);
      let linkId: string;
      try {
        linkId = await links.insert(tx, from.id, to.id, input.kind);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('LINK_ALREADY_EXISTS', 'This link already exists');
        throw error;
      }

      return {
        id: linkId,
        kind: input.kind,
        direction: 'outgoing',
        ticket: { id: to.id, number: to.number, title: to.title, state: to.state },
        removedReason: null,
      };
    });
  }

  async delete(ctx: TenantContext, ticketId: string, linkId: string): Promise<void> {
    const access = await this.access(ctx);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const ticket = await new TicketsRepository(ctx).find(tx, ticketId);
      if (ticket === undefined || !canView(access, ticket.group_id)) throw notFound('ticket');
      requireEdit(access, ticket.group_id);

      const deleted = await new TicketLinksRepository(ctx).delete(tx, linkId, ticketId);
      if (!deleted) throw notFound('link');
    });
  }

  /** Operators under a support-access grant are read-only (FR-001a): writes are always denied. */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Ticket links need a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === 'ticket_links_unique';
}

class TicketLinksRepository extends TenantRepository {
  async insert(tx: TenantTransaction, fromTicketId: string, toTicketId: string, kind: TicketLinkKind): Promise<string> {
    const values: TenantInsert<'ticket_links'> = {
      id: uuidv7(),
      from_ticket_id: fromTicketId,
      to_ticket_id: toTicketId,
      kind,
      created_by: this.ctx.actor.kind === 'user' ? this.ctx.actor.id : null,
    };
    const row = await this.insertInto(tx, 'ticket_links', values).returning('ticket_links.id').executeTakeFirstOrThrow();
    return row.id;
  }

  /** Removes a link touching `ticketId` (either side); returns whether a row was deleted. */
  async delete(tx: TenantTransaction, linkId: string, ticketId: string): Promise<boolean> {
    const result = await this.deleteFrom(tx, 'ticket_links')
      .where('ticket_links.id', '=', linkId)
      .where((eb) => eb.or([eb('ticket_links.from_ticket_id', '=', ticketId), eb('ticket_links.to_ticket_id', '=', ticketId)]))
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
