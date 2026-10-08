import { Global, Injectable, Module } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';

import { grantedGroups, PolicyService } from '../authorization/policy.service.js';
import { roomFor, STAFF_NAMESPACE } from '../platform-kernel/outbox/relay.js';
import { AVAILABILITY_LISTENER, type Availability, type AvailabilityListener } from '../platform-kernel/realtime/presence.service.js';
import { REALTIME_PATH } from '../platform-kernel/realtime/redis-io.adapter.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { Namespace, Server } from 'socket.io';

/**
 * Availability broadcasting (contracts/realtime-events.md `availability.changed`, US14, T238).
 * Viewing and typing presence is broadcast by `TicketPresenceHandler` (ticket-events.ts) and
 * `ConversationTyping` (messaging/conversation-events.ts).
 *
 * When a staff user changes their availability (`PATCH /me`), everyone in the `tickets:group:*`
 * rooms of the groups that user can view gets one ephemeral `availability.changed { userId,
 * availability }`: the people who see that user in owner pickers and presence stacks. Ephemeral
 * like the rest of presence: no outbox row, no `seq`, never replayed. Socket.IO's Redis adapter
 * carries it to sockets on every api process.
 */

const EPHEMERAL_EVENT = 'ephemeral';

function rootServer(namespace: Namespace | Server): Server {
  return 'server' in namespace ? namespace.server : namespace;
}

@Injectable()
@WebSocketGateway({ path: REALTIME_PATH, namespace: STAFF_NAMESPACE })
export class AvailabilityBroadcaster implements OnGatewayInit, AvailabilityListener {
  private server?: Server;

  constructor(private readonly policy: PolicyService) {}

  afterInit(namespace: Namespace | Server): void {
    this.server = rootServer(namespace);
  }

  async changed(ctx: TenantContext, userId: string, availability: Availability): Promise<void> {
    if (this.server === undefined) return;
    const { groupIds, ungrouped } = grantedGroups(await this.policy.effectiveAccess(ctx, userId), 'view');
    const rooms = [...groupIds.map((id) => `tickets:group:${id}`), ...(ungrouped ? ['tickets:group:ungrouped'] : [])].map((stream) =>
      roomFor(ctx.tenantId, stream),
    );
    if (rooms.length === 0) return;
    // One emit to all rooms, so a socket in several of them gets it once.
    this.server.of(STAFF_NAMESPACE).to(rooms).emit(EPHEMERAL_EVENT, {
      type: 'availability.changed',
      stream: 'tickets',
      data: { userId, availability },
    });
  }
}

/** Global so `MeService` (identity) resolves the listener without importing tickets; api process only. */
@Global()
@Module({
  providers: [AvailabilityBroadcaster, { provide: AVAILABILITY_LISTENER, useExisting: AvailabilityBroadcaster }],
  exports: [AVAILABILITY_LISTENER],
})
export class PresenceHttpModule {}
