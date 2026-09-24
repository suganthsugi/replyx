import { Inject, Injectable, Optional } from '@nestjs/common';

import { decide, grantedGroups, PolicyService } from '../../authorization/policy.service.js';
import { isStreamKey, type StreamKey } from '../outbox/event-types.js';

import { socketContext, TICKET_GROUP_LOOKUP, type RealtimeSocket, type TicketGroupLookup } from './socket-context.js';

import type { TenantContext } from '../db/tenant-context.js';

/**
 * Which internal stream keys a socket may read right now, for a client stream name
 * (`user`, `views`, `tickets`, `ticket:{id}`, `conversation`; see `clientStream`). Access is
 * decided on every call, so `sync` never replays what the user can no longer see.
 */
@Injectable()
export class StreamAccess {
  constructor(
    private readonly policy: PolicyService,
    @Optional() @Inject(TICKET_GROUP_LOOKUP) private readonly tickets?: TicketGroupLookup,
  ) {}

  /** Empty when the stream does not exist for this socket or is not visible. */
  async keysFor(socket: RealtimeSocket, stream: string): Promise<StreamKey[]> {
    const { userId, kind } = socket.data;
    if (kind === 'customer') return stream === 'conversation' ? [`conversation:${userId}`] : [];

    if (stream === 'user') return [`user:${userId}`];
    if (stream === 'views') return [`views:${userId}`];
    const ctx = socketContext(socket);
    if (stream === 'tickets') {
      const { groupIds, ungrouped } = grantedGroups(await this.policy.effectiveAccess(ctx, userId), 'view');
      return [
        ...groupIds.map((id): StreamKey => `tickets:group:${id}`),
        ...(ungrouped ? (['tickets:group:ungrouped'] as const) : []),
      ];
    }
    if (stream.startsWith('ticket:') && isStreamKey(stream)) {
      return (await this.canSeeTicket(ctx, stream.slice('ticket:'.length))) ? [stream] : [];
    }
    return [];
  }

  /** Staff view access on the ticket's group; unknown tickets are simply not visible. */
  async canSeeTicket(ctx: TenantContext, ticketId: string): Promise<boolean> {
    if (ctx.actor.kind !== 'user') return false;
    const groupId = await this.tickets?.groupOf(ctx, ticketId);
    if (groupId === undefined) return false;
    const access = await this.policy.effectiveAccess(ctx, ctx.actor.id);
    return decide(access, 'ticket.view', { type: 'ticket', groupId }) === 'allow';
  }
}
