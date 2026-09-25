import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectedSocket, MessageBody, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { z } from 'zod';

import { decide, PolicyService } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { CUSTOMER_NAMESPACE, roomFor, STAFF_NAMESPACE } from '../platform-kernel/outbox/relay.js';
import { PresenceService } from '../platform-kernel/realtime/presence.service.js';
import { REALTIME_PATH } from '../platform-kernel/realtime/redis-io.adapter.js';
import {
  errorAck,
  notFoundAck,
  socketContext,
  TICKET_GROUP_LOOKUP,
  type Ack,
  type RealtimeSocket,
  type TicketGroupLookup,
} from '../platform-kernel/realtime/socket-context.js';
import { ACTIVE_STATES } from '../tickets/tickets.repository.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { Namespace, Server } from 'socket.io';

/**
 * Typing in the conversation (contracts/realtime-events.md, FR-053). Persistent conversation
 * events (`conversation.message`, `.delivery`, `.status`) go through the outbox from the router
 * and the staff messages service; this file handles the ephemeral part, which never touches the
 * database: presence in Redis (30 s TTL) and a direct emit.
 *
 * - Staff `typing { ticketId, state, visibility? }` on `/` needs edit on the ticket's group
 *   (`NOT_FOUND` when the ticket isn't visible). Staff viewing the ticket get `typing`; the
 *   ticket's customer gets `conversation.typing` with the agent's name, unless the agent is
 *   writing an internal note.
 * - Customer `customer.typing { state }` on `/customer` goes to staff viewing the customer's
 *   active ticket. Customers can't target a ticket: the server picks it.
 *
 * Ephemeral signals are emitted as `ephemeral { type, stream, data }` and have no `id` or `seq`.
 */

export const EPHEMERAL_EVENT = 'ephemeral';

export interface EphemeralSignal {
  type: 'typing' | 'conversation.typing';
  stream: string;
  data: Record<string, unknown>;
}

const TypingState = z.enum(['start', 'stop']);
const StaffTyping = z.object({ ticketId: z.uuid(), state: TypingState, visibility: z.enum(['public', 'internal']).default('public') }).strict();
const CustomerTyping = z.object({ state: TypingState }).strict();

function invalidAck(): Ack {
  return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'The request is invalid' } };
}

/** Who typing is about, read from the tenant. */
class TypingRepository extends TenantRepository {
  name(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users').select('users.name').where('users.id', '=', userId).executeTakeFirst();
  }

  customerOf(tx: TenantTransaction, ticketId: string) {
    return this.selectFrom(tx, 'tickets').select('tickets.customer_id').where('tickets.id', '=', ticketId).executeTakeFirst();
  }

  activeTicket(tx: TenantTransaction, customerId: string) {
    return this.selectFrom(tx, 'tickets')
      .select('tickets.id')
      .where('tickets.customer_id', '=', customerId)
      .where('tickets.state', 'in', ACTIVE_STATES)
      .where('tickets.merged_into_id', 'is', null)
      .orderBy('tickets.updated_at', 'desc')
      .orderBy('tickets.id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
}

@Injectable()
export class ConversationTyping {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly presence: PresenceService,
    @Optional() @Inject(TICKET_GROUP_LOOKUP) private readonly tickets?: TicketGroupLookup,
  ) {}

  async staff(server: Server, socket: RealtimeSocket, body: unknown): Promise<Ack> {
    const parsed = StaffTyping.safeParse(body);
    if (!parsed.success) return invalidAck();
    const { ticketId, state, visibility } = parsed.data;
    const ctx = socketContext(socket);
    const groupId = await this.tickets?.groupOf(ctx, ticketId);
    if (groupId === undefined) return notFoundAck();
    const access = await this.policy.effectiveAccess(ctx, socket.data.userId);
    const decision = decide(access, 'ticket.edit', { type: 'ticket', groupId });
    if (decision === 'not_found') return notFoundAck();
    if (decision === 'deny') return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to do this' } };

    const { tenantId, userId } = socket.data;
    await this.presence.typing(tenantId, ticketId, userId, state);
    const { name, customerId } = await this.readOnly(ctx, async (tx, repo) => ({
      name: (await repo.name(tx, userId))?.name ?? 'Support',
      customerId: (await repo.customerOf(tx, ticketId))?.customer_id,
    }));

    emit(server, STAFF_NAMESPACE, roomFor(tenantId, `ticket:${ticketId}`), {
      type: 'typing',
      stream: `ticket:${ticketId}`,
      data: { ticketId, user: { id: userId, name, avatarUrl: null }, state },
    });
    if (visibility === 'public' && customerId !== undefined) {
      emit(server, CUSTOMER_NAMESPACE, roomFor(tenantId, `conversation:${customerId}`), {
        type: 'conversation.typing',
        stream: 'conversation',
        data: { name, avatarUrl: null, state },
      });
    }
    return { ok: true };
  }

  async customer(server: Server, socket: RealtimeSocket, body: unknown): Promise<Ack> {
    const parsed = CustomerTyping.safeParse(body);
    if (!parsed.success) return invalidAck();
    const { state } = parsed.data;
    const { tenantId, userId } = socket.data;
    const ctx = socketContext(socket);
    const { name, ticketId } = await this.readOnly(ctx, async (tx, repo) => ({
      name: (await repo.name(tx, userId))?.name ?? 'Customer',
      ticketId: (await repo.activeTicket(tx, userId))?.id,
    }));
    // Nobody is working on anything yet: there is no one to tell.
    if (ticketId === undefined) return { ok: true };

    await this.presence.typing(tenantId, ticketId, `customer:${userId}`, state);
    emit(server, STAFF_NAMESPACE, roomFor(tenantId, `ticket:${ticketId}`), {
      type: 'typing',
      stream: `ticket:${ticketId}`,
      data: { ticketId, user: { kind: 'customer', name }, state },
    });
    return { ok: true };
  }

  private readOnly<T>(ctx: TenantContext, fn: (tx: TenantTransaction, repo: TypingRepository) => Promise<T>): Promise<T> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => fn(tx, new TypingRepository(ctx)));
  }
}

function emit(server: Server, namespace: string, room: string, signal: EphemeralSignal): void {
  server.of(namespace).to(room).emit(EPHEMERAL_EVENT, signal);
}

/** The root `Server` from whatever Nest passes a gateway's `afterInit`. */
function rootServer(namespace: Namespace | Server): Server {
  return 'server' in namespace ? namespace.server : namespace;
}

/** Staff typing, on the staff namespace next to the kernel's `StaffGateway`. */
@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: STAFF_NAMESPACE })
export class StaffTypingGateway implements OnGatewayInit {
  private readonly logger = new Logger('StaffTypingGateway');
  private server?: Server;

  constructor(private readonly typing: ConversationTyping) {}

  afterInit(namespace: Namespace | Server): void {
    this.server = rootServer(namespace);
  }

  @SubscribeMessage('typing')
  onTyping(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    if (this.server === undefined) return Promise.resolve(notFoundAck());
    return this.typing.staff(this.server, socket, body).catch((error: unknown) => {
      this.logger.warn(`Typing failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return errorAck(error);
    });
  }
}

/** Customer typing, on the customer namespace next to the kernel's `CustomerGateway`. */
@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: CUSTOMER_NAMESPACE })
export class CustomerTypingGateway implements OnGatewayInit {
  private readonly logger = new Logger('CustomerTypingGateway');
  private server?: Server;

  constructor(private readonly typing: ConversationTyping) {}

  afterInit(namespace: Namespace | Server): void {
    this.server = rootServer(namespace);
  }

  @SubscribeMessage('customer.typing')
  onTyping(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    if (this.server === undefined) return Promise.resolve(notFoundAck());
    return this.typing.customer(this.server, socket, body).catch((error: unknown) => {
      this.logger.warn(`Typing failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return errorAck(error);
    });
  }
}
