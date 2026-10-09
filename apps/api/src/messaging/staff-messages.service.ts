import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ticketAiView } from '../ai/assistant/ai-ticket-view.js';
import { assertOpenAiDraft } from '../ai/drafts/ai-draft-reference.js';
import { AccessRepository, decide, PolicyService, type EffectiveAccess } from '../authorization/policy.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound, permissionDenied, validationFailed } from '../platform-kernel/http/app-error.js';
import { decodeCursor, toPage, type Page } from '../platform-kernel/http/pagination.js';
import { uuidv7 } from '../platform-kernel/ids.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';
import { allowedActions, TicketRefsRepository, toTicketDto, type TicketDto } from '../tickets/ticket-dto.js';
import { ticketStream } from '../tickets/ticket-events.js';
import { TicketsRepository, type TicketRow } from '../tickets/tickets.repository.js';

import { toMessageDto, type MessageDto } from './message-dto.js';
import { MessagesRepository, type MessageRow } from './messages.repository.js';
import { PublicReplyService } from './public-reply.service.js';

import type { PermissionKey } from '../authorization/registry/module-permissions.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * The staff side of a conversation (contracts/tickets.yaml `/tickets/{id}`,
 * `/tickets/{id}/messages`, FR-033, FR-036, FR-039).
 *
 * - Reads need view on the ticket's group; a ticket outside it is 404 like a missing one.
 * - Writes need edit on the group (403 when the ticket is visible but edit is not granted).
 * - A public reply is also a customer event: it reaches the customer's conversation as a
 *   projection, moves `new` to `open` on the first reply, sets the reply timestamps and
 *   `waiting_on = customer`, and marks the customer's messages on the ticket read.
 * - An internal note stays on the ticket stream only: no customer event, no state change, and no
 *   customer notification (the offline email consumer ignores it).
 * - Opening the timeline marks the customer's messages delivered (✓✓ in the chat).
 */

export interface StaffMessageInput {
  visibility: 'public' | 'internal';
  body: string;
  clientMessageId: string;
  attachmentIds: readonly string[];
  mentionIds: readonly string[];
  /** The AI draft a public reply was composed from (spec 002 R13); kept in the message metadata. */
  aiDraftId?: string;
}

const Position = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();

const ATTACHMENT_TTL_MS = 24 * 3_600_000;

const MAX_MENTION_CANDIDATES = 20;

export interface MentionCandidateDto {
  id: string;
  name: string;
  avatarUrl: string | null;
}

const SUPPORT = 'support' as const;
type Viewer = EffectiveAccess | typeof SUPPORT;

function canView(access: Viewer, groupId: string | null): boolean {
  return access === SUPPORT || decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
}

@Injectable()
export class StaffMessagesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly replies: PublicReplyService,
  ) {}

  async ticket(ctx: TenantContext, ticketId: string): Promise<TicketDto> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await this.visible(ctx, tx, access, ticketId);
      const refs = new TicketRefsRepository(ctx);
      const [names, links] = await Promise.all([
        refs.load(tx, [row]),
        refs.links(tx, row.id, (groupId) => canView(access, groupId)),
      ]);
      const actions = access === SUPPORT ? [] : allowedActions(access, row.group_id);
      return { ...toTicketDto(row, names, links, actions), ...(await ticketAiView(tx, ctx, row, actions.includes('edit'))) };
    });
  }

  async messages(ctx: TenantContext, ticketId: string, query: { limit: number; cursor?: string }): Promise<Page<MessageDto>> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, Position);
    const access = await this.access(ctx);
    const page = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await this.visible(ctx, tx, access, ticketId);
      const repo = new MessagesRepository(ctx);
      const rows = await repo.listForTicket(tx, row.id, query.limit + 1, after === undefined ? undefined : { createdAt: new Date(after.createdAt), id: after.id });
      const refs = await this.refs(ctx, tx, rows.slice(0, query.limit));
      return {
        ticket: row,
        page: toPage(rows, query.limit, (message) => ({ createdAt: message.created_at.toISOString(), id: message.id }), (message) => toMessageDto(message, refs)),
      };
    });
    // Support sessions are read-only; only a staff member's own reading counts as delivery.
    if (ctx.actor.kind === 'user' && !ctx.readOnly) await this.markDelivered(ctx, page.ticket);
    return page.page;
  }

  /**
   * Who an internal note on the ticket can @mention (FR-081): active staff who can view its group,
   * id, name and avatar only. Gated like posting a note (`ticket.edit` on the group), and a ticket
   * outside the caller's view is the same 404 as a missing one.
   */
  async mentionCandidates(ctx: TenantContext, ticketId: string, prefix: string): Promise<MentionCandidateDto[]> {
    const access = await this.access(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await new TicketsRepository(ctx).find(tx, ticketId);
      if (row === undefined) throw notFound('ticket');
      require(access, 'ticket.edit', row.group_id);
      const staff = await new AccessRepository(ctx).mentionableStaff(tx, row.group_id, prefix, MAX_MENTION_CANDIDATES);
      // Avatars arrive with the attachments module.
      return staff.map((user) => ({ id: user.id, name: user.name, avatarUrl: null }));
    });
  }

  async post(ctx: TenantContext, ticketId: string, input: StaffMessageInput): Promise<MessageDto> {
    const access = await this.access(ctx);
    const authorId = actorId(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const tickets = new TicketsRepository(ctx);
      const locked = await tickets.lock(tx, ticketId);
      if (locked === undefined) throw notFound('ticket');
      require(access, 'ticket.edit', locked.group_id);
      return this.insertMessage(ctx, tx, authorId, locked, input);
    });
  }

  /**
   * Inserts a message on an already-locked (or just-created) ticket, within the caller's
   * transaction. `post` above gates this with `ticket.edit` on the ticket's group; a ticket the
   * caller just created (`staff-started-ticket.service.ts`, gated by `ticket.create` instead)
   * calls this directly, so the customer projection and offline email still fire for its first
   * message exactly as they do for any other public reply.
   */
  async insertMessage(ctx: TenantContext, tx: TenantTransaction, authorId: string, locked: TicketRow, input: StaffMessageInput): Promise<MessageDto> {
    const messages = new MessagesRepository(ctx);
    const existing = await messages.findByClientMessageId(tx, authorId, input.clientMessageId);
    if (existing !== undefined) return toMessageDto(existing, await this.refs(ctx, tx, [existing]));

    const mentions = [...new Set(input.mentionIds)];
    if (input.visibility === 'public' && mentions.length > 0) throw validationFailed([{ path: 'mentionIds', issue: 'invalid' }]);
    if (!(await new StaffRepository(ctx).allActiveStaff(tx, mentions))) throw validationFailed([{ path: 'mentionIds', issue: 'invalid' }]);

    // Only a public reply can be sent from a draft; on a note the field is a client error.
    if (input.aiDraftId !== undefined) {
      if (input.visibility !== 'public') throw validationFailed([{ path: 'aiDraftId', issue: 'invalid' }]);
      await assertOpenAiDraft(ctx, tx, locked.id, input.aiDraftId);
    }

    const now = this.clock.now();
    const message = await messages.insert(tx, {
      id: uuidv7(),
      ticket_id: locked.id,
      author_id: authorId,
      author_kind: 'staff',
      visibility: input.visibility,
      body: input.body,
      client_message_id: input.clientMessageId,
      metadata: input.aiDraftId === undefined ? undefined : JSON.stringify({ aiDraftId: input.aiDraftId }),
      mentions,
      created_at: now,
      updated_at: now,
    });
    const attachmentIds = [...new Set(input.attachmentIds)];
    const bound = await messages.bindAttachments(tx, message.id, authorId, attachmentIds, new Date(now.getTime() - ATTACHMENT_TTL_MS));
    if (bound !== attachmentIds.length) throw validationFailed([{ path: 'attachmentIds', issue: 'invalid' }]);

    const dto = toMessageDto(message, await this.refs(ctx, tx, [message]));
    if (input.visibility === 'internal') {
      await this.outbox.append(tx, { type: 'message.created', payload: dto, streams: [ticketStream(locked.id)] });
      return dto;
    }
    await this.replies.publish(ctx, tx, locked, message, dto, now);
    return dto;
  }

  private async markDelivered(ctx: TenantContext, ticket: TicketRow): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const delivered = await new MessagesRepository(ctx).markCustomerMessages(tx, ticket.id, 'delivered_at', this.clock.now());
      await this.replies.announceReceipts(tx, ticket.id, ticket.customer_id, delivered, 'delivered');
    });
  }

  /** The ticket if the caller may view it; otherwise the same 404 as a missing ticket. */
  private async visible(ctx: TenantContext, tx: TenantTransaction, access: Viewer, ticketId: string): Promise<TicketRow> {
    const row = await new TicketsRepository(ctx).find(tx, ticketId);
    if (row === undefined || !canView(access, row.group_id)) {
      throw notFound('ticket');
    }
    return row;
  }

  /** Operators under a support-access grant read every ticket (read-only, FR-001a). */
  private async access(ctx: TenantContext): Promise<Viewer> {
    if (ctx.actor.kind === 'operator') return SUPPORT;
    return this.policy.effectiveAccess(ctx, actorId(ctx));
  }

  private refs(ctx: TenantContext, tx: TenantTransaction, rows: readonly MessageRow[]) {
    return this.replies.refs(ctx, tx, rows);
  }
}

/** Throws 404 when the ticket is invisible and 403 when the action is denied. */
function require(access: Viewer, key: PermissionKey, groupId: string | null): void {
  // Support sessions never reach a write: the support guard allows GET only.
  if (access === SUPPORT) throw permissionDenied();
  const decision = decide(access, key, { type: 'ticket', groupId });
  if (decision === 'not_found') throw notFound('ticket');
  if (decision === 'deny') throw permissionDenied();
}

function actorId(ctx: TenantContext): string {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'operator') return ctx.actor.id;
  throw new Error('Staff messaging needs a user actor');
}

class StaffRepository extends TenantRepository {
  async allActiveStaff(tx: TenantTransaction, ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const rows = await this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.id', 'in', ids)
      .where('users.kind', '=', 'staff')
      .where('users.status', '=', 'active')
      .execute();
    return rows.length === ids.length;
  }
}
