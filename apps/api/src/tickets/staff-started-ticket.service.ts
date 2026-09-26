import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AccessRepository, decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { MessagesRepository } from '../messaging/messages.repository.js';
import { StaffMessagesService } from '../messaging/staff-messages.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, permissionDenied } from '../platform-kernel/http/app-error.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { TagsService } from '../tags/tags.service.js';

import { initialState } from './state-machine.js';
import { allowedActions, TicketRefsRepository, toTicketDto, type RefDto, type TicketDto } from './ticket-dto.js';
import { groupStream, summaryOf } from './ticket-events.js';
import { TicketNumberService } from './ticket-number.service.js';
import { TicketsRepository, type TicketRow } from './tickets.repository.js';

import type { TicketPriority } from '../platform-kernel/db/tables/tickets.js';

/**
 * `POST /tickets` (contracts/tickets.yaml, FR-038a, T136): staff start a ticket for an existing,
 * active customer of the tenant, on a group they have `create` access to — not `edit`, so the
 * caller need not already be able to work tickets in that group to start one there. Routing is
 * skipped entirely: `state-machine.ts` `initialState('staff_started')` is already `open`, and
 * `waiting_on` starts at `customer`.
 *
 * The first message reuses `StaffMessagesService.insertMessage` (the same insert, attachment
 * binding and public-reply event emission `POST /tickets/{id}/messages` uses), so it reaches the
 * customer's thread as a projection and the offline-email consumer sees it exactly like any other
 * public reply (FR-038a, FR-055).
 *
 * `Idempotency-Key`, when sent, becomes the message's `client_message_id`: a retried request finds
 * the message already stored (`MessagesRepository.findByClientMessageId`) and returns its ticket
 * instead of creating a second one. The advisory lock is the same one
 * `CustomerMessageRouter.accept` takes (`tenant:customer`), so a staff-started create can't race
 * that customer's own message into two separate tickets.
 */

export interface StaffStartedMessageInput {
  body: string;
  attachmentIds: readonly string[];
}

export interface StaffStartedTicketInput {
  customerId: string;
  groupId: string;
  title: string;
  message: StaffStartedMessageInput;
  ownerId?: string;
  priority?: TicketPriority;
  tagIds?: readonly string[];
}

const SUPPORT = 'support' as const;
type Viewer = EffectiveAccess | typeof SUPPORT;

function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

/** Throws 404 when the group is invisible (no `ticket.create` anywhere) and 403 when denied there. */
function require(access: Viewer, groupId: string): void {
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, 'ticket.create', { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound('group');
  if (decision === 'deny') throw permissionDenied();
}

/** Only a signed-in staff user (or an operator, always denied by `require` above) may start one. */
function actorId(ctx: TenantContext): string {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'operator') return ctx.actor.id;
  throw new Error('Starting a ticket needs a user actor');
}

@Injectable()
export class StaffStartedTicketService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly numbers: TicketNumberService,
    private readonly tags: TagsService,
    private readonly staffMessages: StaffMessagesService,
  ) {}

  async create(ctx: TenantContext, input: StaffStartedTicketInput, idempotencyKey: string | undefined): Promise<TicketDto> {
    const access = await this.access(ctx);
    const authorId = actorId(ctx);
    const clientMessageId = idempotencyKey ?? uuidv7();

    return this.unitOfWork.withTenant(ctx, async (tx) => {
      require(access, input.groupId);
      if ((await new GroupStatusRepository(ctx).status(tx, input.groupId)) !== 'active') {
        throw conflict('GROUP_INACTIVE', 'The group is not active');
      }
      if (input.ownerId !== undefined) {
        const eligible = await new AccessRepository(ctx).eligibleOwners(tx, input.groupId);
        if (!eligible.some((owner) => owner.id === input.ownerId)) {
          throw conflict('OWNER_NOT_ELIGIBLE', 'This owner does not have edit access on the ticket’s group');
        }
      }

      // Same lock `CustomerMessageRouter.accept` takes: serializes every write that could touch
      // this customer's tickets, staff-started or not.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:${input.customerId}`}))`.execute(tx);
      const customer = await new CustomerRepository(ctx).active(tx, input.customerId);
      if (customer === undefined) throw conflict('CUSTOMER_INACTIVE', 'The customer is not active');

      const retried = await new MessagesRepository(ctx).findByClientMessageId(tx, authorId, clientMessageId);
      if (retried !== undefined) {
        const ticket = await new TicketsRepository(ctx).find(tx, retried.ticket_id);
        if (ticket !== undefined) return this.toDto(ctx, tx, access, ticket, await this.tagsOf(tx, ticket.id));
      }

      const tagIds = [...new Set(input.tagIds ?? [])];
      await this.tags.assertTagsExist(tx, tagIds);

      const now = this.clock.now();
      const ticket = await new TicketsRepository(ctx).insert(tx, {
        id: uuidv7(),
        number: await this.numbers.next(tx),
        title: input.title,
        customer_id: customer.id,
        group_id: input.groupId,
        owner_id: input.ownerId ?? null,
        state: initialState('staff_started'),
        origin: 'staff_started',
        waiting_on: 'customer',
        created_at: now,
        updated_at: now,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      });
      if (tagIds.length > 0) await this.tags.setTicketTags(tx, ticket.id, tagIds);
      const tagRefs = await this.tagsOf(tx, ticket.id);

      await this.outbox.append(tx, {
        type: 'ticket.created',
        payload: { ticket: await summaryOf(ctx, tx, ticket, tagRefs) },
        streams: [groupStream(ticket.group_id)],
      });

      await this.staffMessages.insertMessage(ctx, tx, authorId, ticket, {
        visibility: 'public',
        body: input.message.body,
        clientMessageId,
        attachmentIds: input.message.attachmentIds,
        mentionIds: [],
      });

      return this.toDto(ctx, tx, access, ticket, tagRefs);
    });
  }

  private tagsOf(tx: TenantTransaction, ticketId: string): Promise<RefDto[]> {
    return this.tags.tagsByTicketIds(tx, [ticketId]).then((byTicket) => byTicket.get(ticketId) ?? []);
  }

  private async toDto(ctx: TenantContext, tx: TenantTransaction, access: Viewer, row: TicketRow, tags: readonly RefDto[]): Promise<TicketDto> {
    const refs = new TicketRefsRepository(ctx);
    const [names, links] = await Promise.all([refs.load(tx, [row]), refs.links(tx, row.id, (groupId) => canView(access, groupId))]);
    return toTicketDto(row, names, links, access === SUPPORT ? [] : allowedActions(access, row.group_id), tags);
  }

  /** Operators under a support-access grant are read-only (FR-001a): writes are always denied. */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    if (ctx.actor.kind !== 'user') throw new Error('Starting a ticket needs a user actor');
    return this.policy.effectiveAccess(ctx, ctx.actor.id);
  }
}

class GroupStatusRepository extends TenantRepository {
  async status(tx: TenantTransaction, groupId: string): Promise<'active' | 'inactive' | undefined> {
    const row = await this.selectFrom(tx, 'groups').select('groups.status').where('groups.id', '=', groupId).executeTakeFirst();
    return row?.status;
  }
}

class CustomerRepository extends TenantRepository {
  active(tx: TenantTransaction, userId: string): Promise<{ id: string } | undefined> {
    return this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.id', '=', userId)
      .where('users.kind', '=', 'customer')
      .where('users.status', '=', 'active')
      .executeTakeFirst();
  }
}
