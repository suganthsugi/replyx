import { Global, Injectable, Module } from '@nestjs/common';

import { GROUP_TICKET_STATS, type GroupTicketStats } from '../groups/groups.service.js';
import { USER_HISTORY_CHECKS, type UserHistoryCheck } from '../identity/users.service.js';
import { MessagingHttpModule } from '../messaging/messaging.module.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { RealtimeModule } from '../platform-kernel/realtime/gateway.js';
import { TICKET_GROUP_LOOKUP, type TicketGroupLookup } from '../platform-kernel/realtime/socket-context.js';
import { ViewCompiler } from '../views/view-compiler.js';

import { MessageMoveService } from './message-move.service.js';
import { StaffStartedTicketService } from './staff-started-ticket.service.js';
import { TicketPresenceGateway, TicketPresenceHandler } from './ticket-events.js';
import { TicketHistoryQueryService } from './ticket-history-query.service.js';
import { TicketHistoryService } from './ticket-history.service.js';
import { TicketLinksController } from './ticket-links.controller.js';
import { TicketLinksService } from './ticket-links.service.js';
import { TicketNumberService } from './ticket-number.service.js';
import { TicketQueryService } from './ticket-query.service.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The tickets module's services and the answers it gives other modules (P5-2, realtime-events
 * rule 7): open-ticket counts for groups, the group of a ticket for `ticket:*` subscriptions, and
 * whether a user has ticket history (FR-009). Global so the groups, identity and realtime
 * modules can resolve the tokens without importing tickets.
 */

function scopeOf(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('Ticket queries must run inside withTenant');
  return ctx;
}

@Injectable()
export class TicketGroupStats implements GroupTicketStats {
  openTicketCounts(tx: TenantTransaction, groupIds: readonly string[]) {
    return new TicketsRepository(scopeOf(tx)).openCountsByGroup(tx, groupIds);
  }

  openTicketCountsByOwner(tx: TenantTransaction, userIds: readonly string[]) {
    return new TicketsRepository(scopeOf(tx)).openCountsByOwner(tx, userIds);
  }

  hasTickets(tx: TenantTransaction, groupId: string) {
    return new TicketsRepository(scopeOf(tx)).groupHasTickets(tx, groupId);
  }
}

@Injectable()
export class TicketGroups implements TicketGroupLookup {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  groupOf(ctx: TenantContext, ticketId: string): Promise<string | null | undefined> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => new TicketsRepository(ctx).groupOf(tx, ticketId));
  }
}

/** A user who is a ticket's customer, wrote a message or changed a ticket has history. */
export class TicketUserHistory implements UserHistoryCheck {
  async hasHistory(tx: TenantTransaction, userId: string): Promise<boolean> {
    const ctx = scopeOf(tx);
    if (await new TicketsRepository(ctx).customerHasTickets(tx, userId)) return true;
    return new AuthoredRecordsRepository(ctx).hasAuthored(tx, userId);
  }
}

class AuthoredRecordsRepository extends TenantRepository {
  async hasAuthored(tx: TenantTransaction, userId: string): Promise<boolean> {
    const [message, change] = await Promise.all([
      this.selectFrom(tx, 'ticket_messages').select('ticket_messages.id').where('ticket_messages.author_id', '=', userId).limit(1).executeTakeFirst(),
      this.selectFrom(tx, 'ticket_history').select('ticket_history.id').where('ticket_history.actor_id', '=', userId).limit(1).executeTakeFirst(),
    ]);
    return message !== undefined || change !== undefined;
  }
}

@Global()
@Module({
  providers: [
    TicketNumberService,
    TicketHistoryService,
    { provide: GROUP_TICKET_STATS, useClass: TicketGroupStats },
    { provide: TICKET_GROUP_LOOKUP, useClass: TicketGroups },
    { provide: USER_HISTORY_CHECKS, useFactory: () => [new TicketUserHistory()] },
  ],
  exports: [TicketNumberService, TicketHistoryService, GROUP_TICKET_STATS, TICKET_GROUP_LOOKUP, USER_HISTORY_CHECKS],
})
export class TicketsModule {}

/** HTTP side of tickets (api process only, contracts/tickets.yaml `/tickets*`). */
@Module({
  imports: [RealtimeModule, MessagingHttpModule],
  controllers: [TicketsController, TicketLinksController],
  providers: [
    TicketsService,
    TicketQueryService,
    ViewCompiler,
    TicketPresenceHandler,
    TicketPresenceGateway,
    StaffStartedTicketService,
    TicketLinksService,
    TicketHistoryQueryService,
    MessageMoveService,
  ],
})
export class TicketsHttpModule {}
