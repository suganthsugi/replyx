import { Injectable, Logger } from '@nestjs/common';

import { grantedGroups, PolicyService } from '../../authorization/policy.service.js';
import { uuidv7 } from '../ids.js';
import { ENVELOPE_EVENT, roomFor, STAFF_NAMESPACE, type ControlMessage, type Envelope } from '../outbox/relay.js';

import { socketContext, tenantRoom, type RealtimeSocket } from './socket-context.js';
import { StreamAccess } from './stream-access.js';

import type { DomainEventPayload } from '../outbox/event-types.js';
import type { Server } from 'socket.io';

/**
 * Live access revocation (FR-025, SC-011). Every api process receives `access.changed` from the
 * relay and handles its own staff sockets in that tenant: recompute the `tickets:group:*` rooms
 * from the new effective access, re-check each joined `ticket:*` room, leave what is no longer
 * allowed, then send the socket `access.changed { accessVersion }` and, when something was
 * lost, `access.revoked { ticketIds?, groupIds? }` on its `user` stream so open screens close.
 *
 * The access version was bumped in the committing transaction, so the policy service reads
 * fresh grants (the cache key contains the version).
 */

type LocalSocket = Pick<RealtimeSocket, 'id' | 'data' | 'rooms' | 'join' | 'leave' | 'emit'>;

const GROUP_ROOM = /^t:[^:]+:tickets:group:(.+)$/;
const TICKET_ROOM = /^t:[^:]+:ticket:(.+)$/;

@Injectable()
export class AccessChangeHandler {
  private readonly logger = new Logger('AccessChangeHandler');

  constructor(
    private readonly policy: PolicyService,
    private readonly access: StreamAccess,
  ) {}

  async handle(server: Server, message: ControlMessage): Promise<void> {
    const payload = message.payload as unknown as DomainEventPayload<'access.changed'>;
    const sockets = (await server.of(STAFF_NAMESPACE).local.in(tenantRoom(message.tenantId)).fetchSockets()) as unknown as LocalSocket[];
    await Promise.all(
      sockets.map((socket) =>
        this.recompute(socket, message, payload.accessVersion).catch((error: unknown) => {
          this.logger.error(`Access recompute failed for socket ${socket.id}: ${error instanceof Error ? error.message : 'unknown'}`);
        }),
      ),
    );
  }

  /** Brings one socket's rooms in line with current access and notifies it. */
  async recompute(socket: LocalSocket, message: ControlMessage, accessVersion: string): Promise<void> {
    const ctx = socketContext(socket as RealtimeSocket);
    const { tenantId, userId } = socket.data;
    const { groupIds, ungrouped } = grantedGroups(await this.policy.effectiveAccess(ctx, userId), 'view');
    const allowedGroups = new Set<string>([...groupIds, ...(ungrouped ? ['ungrouped'] : [])]);

    const revokedGroups: (string | null)[] = [];
    const revokedTickets: string[] = [];
    for (const room of [...socket.rooms]) {
      const group = GROUP_ROOM.exec(room)?.[1];
      if (group !== undefined) {
        if (!allowedGroups.has(group)) {
          await socket.leave(room);
          revokedGroups.push(group === 'ungrouped' ? null : group);
        }
        continue;
      }
      const ticket = TICKET_ROOM.exec(room)?.[1];
      if (ticket !== undefined && !(await this.access.canSeeTicket(ctx, ticket))) {
        await socket.leave(room);
        revokedTickets.push(ticket);
      }
    }
    // Newly granted groups start streaming list updates right away.
    const joined = new Set(socket.rooms);
    const toJoin = [...allowedGroups].map((group) => roomFor(tenantId, `tickets:group:${group}`)).filter((room) => !joined.has(room));
    if (toJoin.length > 0) await socket.join(toJoin);

    const base = { seq: message.seq, stream: 'user', occurredAt: message.occurredAt, actor: { kind: 'system' as const } };
    socket.emit(ENVELOPE_EVENT, { ...base, id: message.id, type: 'access.changed', data: { accessVersion } } satisfies Envelope);
    if (revokedGroups.length > 0 || revokedTickets.length > 0) {
      socket.emit(ENVELOPE_EVENT, {
        ...base,
        id: uuidv7(),
        type: 'access.revoked',
        data: {
          ...(revokedTickets.length > 0 ? { ticketIds: revokedTickets } : {}),
          ...(revokedGroups.length > 0 ? { groupIds: revokedGroups } : {}),
        },
      } satisfies Envelope);
    }
  }
}
