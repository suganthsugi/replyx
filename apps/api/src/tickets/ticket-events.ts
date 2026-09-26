import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConnectedSocket, MessageBody, type OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { z } from 'zod';

import { decide, PolicyService } from '../authorization/policy.service.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { STAFF_NAMESPACE, roomFor } from '../platform-kernel/outbox/relay.js';
import { PresenceService, type TicketPresence } from '../platform-kernel/realtime/presence.service.js';
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

import { TicketRefsRepository, toTicketSummary, type RefDto, type TicketSummaryDto } from './ticket-dto.js';

import type { TicketRow } from './tickets.repository.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { StreamKey } from '../platform-kernel/outbox/event-types.js';
import type { Namespace, Server } from 'socket.io';

/**
 * Stream keys and payload helpers shared by everything that announces ticket changes
 * (contracts/realtime-events.md "Staff events"), plus the one part of the `ticket:{id}` stream
 * that isn't a persistent domain event: presence.
 *
 * - `ticket.created`, `ticket.updated` and `ticket.removed_from_view` reach `tickets:group:*`
 *   through `groupStream` (`tickets.service.ts` appends them to the outbox with it); `ticket.updated`
 *   also reaches `ticket:{id}` through `ticketStream`. `message.created` (staff and internal notes)
 *   and `message.moved` are the messaging module's own outbox events on `ticketStream`.
 *   `typing` (staff `typing` / customer `customer.typing`) is already ephemeral, direct-emit
 *   (`messaging/conversation-events.ts`, T111).
 * - `presence` is the missing ephemeral half (T143): who is currently looking at a ticket, for
 *   collision awareness. `viewing { ticketId, state: "enter" | "leave" }` needs `ticket.view` on
 *   the ticket (`NOT_FOUND` otherwise, constitution I); on success every socket in `ticket:{id}`
 *   gets the ticket's current viewers and typers, resolved to names. It shares the same Redis sets
 *   as typing (`PresenceService`), never the database or the outbox.
 */

/** The list room of a group; `null` is Ungrouped. */
export function groupStream(groupId: string | null): StreamKey {
  return `tickets:group:${groupId ?? 'ungrouped'}`;
}

export function ticketStream(ticketId: string): StreamKey {
  return `ticket:${ticketId}`;
}

export async function summaryOf(ctx: TenantContext, tx: TenantTransaction, row: TicketRow, tags: readonly RefDto[] = []): Promise<TicketSummaryDto> {
  return toTicketSummary(row, await new TicketRefsRepository(ctx).load(tx, [row]), tags);
}

/** The same socket.io event name `messaging/conversation-events.ts` uses for `typing`. */
const EPHEMERAL_EVENT = 'ephemeral';

const ViewingState = z.enum(['enter', 'leave']);
const Viewing = z.object({ ticketId: z.uuid(), state: ViewingState }).strict();

function invalidAck(): Ack {
  return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'The request is invalid' } };
}

export interface PresenceUserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type PresenceMemberRef = PresenceUserRef | { kind: 'customer'; name: string };

/** Names for presence members: staff by id, customers by the id after the `customer:` prefix. */
class PresenceNamesRepository extends TenantRepository {
  async namesOf(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'users').select(['users.id', 'users.name']).where('users.id', 'in', userIds).execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

/** The root `Server` from whatever Nest passes a gateway's `afterInit`. */
function rootServer(namespace: Namespace | Server): Server {
  return 'server' in namespace ? namespace.server : namespace;
}

/** Resolves a raw `TicketPresence` (member ids) into display refs. */
async function resolvePresence(
  ctx: TenantContext,
  tx: TenantTransaction,
  presence: TicketPresence,
): Promise<{ viewers: PresenceUserRef[]; typing: PresenceMemberRef[] }> {
  const customerPrefix = 'customer:';
  const staffIds = new Set(presence.viewers);
  const customerIds = new Set<string>();
  for (const member of presence.typing) {
    if (member.startsWith(customerPrefix)) customerIds.add(member.slice(customerPrefix.length));
    else staffIds.add(member);
  }
  const names = await new PresenceNamesRepository(ctx).namesOf(tx, [...staffIds, ...customerIds]);
  const staffRef = (id: string): PresenceUserRef => ({ id, name: names.get(id) ?? 'Unknown', avatarUrl: null });
  return {
    viewers: presence.viewers.map(staffRef),
    typing: presence.typing.map((member) =>
      member.startsWith(customerPrefix)
        ? { kind: 'customer' as const, name: names.get(member.slice(customerPrefix.length)) ?? 'Customer' }
        : staffRef(member),
    ),
  };
}

@Injectable()
export class TicketPresenceHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly presence: PresenceService,
    @Optional() @Inject(TICKET_GROUP_LOOKUP) private readonly tickets?: TicketGroupLookup,
  ) {}

  async viewing(server: Server, socket: RealtimeSocket, body: unknown): Promise<Ack> {
    const parsed = Viewing.safeParse(body);
    if (!parsed.success) return invalidAck();
    const { ticketId, state } = parsed.data;
    const ctx = socketContext(socket);
    const groupId = await this.tickets?.groupOf(ctx, ticketId);
    if (groupId === undefined) return notFoundAck();
    const access = await this.policy.effectiveAccess(ctx, socket.data.userId);
    if (decide(access, 'ticket.view', { type: 'ticket', groupId }) !== 'allow') return notFoundAck();

    const { tenantId, userId } = socket.data;
    const raw = await this.presence.viewing(tenantId, ticketId, userId, state);
    const resolved = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => resolvePresence(ctx, tx, raw));
    server.of(STAFF_NAMESPACE).to(roomFor(tenantId, `ticket:${ticketId}`)).emit(EPHEMERAL_EVENT, {
      type: 'presence',
      stream: `ticket:${ticketId}`,
      data: { ticketId, ...resolved },
    });
    return { ok: true };
  }
}

/** Staff presence on a ticket screen (`viewing`, next to the kernel's `StaffGateway`). */
@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: STAFF_NAMESPACE })
export class TicketPresenceGateway implements OnGatewayInit {
  private server?: Server;

  constructor(private readonly handler: TicketPresenceHandler) {}

  afterInit(namespace: Namespace | Server): void {
    this.server = rootServer(namespace);
  }

  @SubscribeMessage('viewing')
  onViewing(@ConnectedSocket() socket: RealtimeSocket, @MessageBody() body: unknown): Promise<Ack> {
    if (this.server === undefined) return Promise.resolve(notFoundAck());
    return this.handler.viewing(this.server, socket, body).catch(errorAck);
  }
}
