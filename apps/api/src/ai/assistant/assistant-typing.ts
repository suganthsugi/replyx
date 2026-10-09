import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';

import { CUSTOMER_NAMESPACE, roomFor, STAFF_NAMESPACE } from '../../platform-kernel/outbox/relay.js';
import { PresenceService } from '../../platform-kernel/realtime/presence.service.js';
import { createRedis, redisUrl } from '../../platform-kernel/redis/redis.module.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import type { Redis } from 'ioredis';

/** The assistant's pseudo-author in typing presence (contracts/realtime-events.md). */
export const ASSISTANT_PRESENCE_MEMBER = 'assistant';
const HEARTBEAT_MS = 15_000;
const EPHEMERAL_EVENT = 'ephemeral';

export interface TypingTarget {
  ctx: TenantContext;
  ticketId: string;
  customerId: string;
  /** Auto-reply only: in Drafts mode nothing is going to be said to the customer. */
  showToCustomer: boolean;
}

/**
 * The assistant's typing indicator while its model runs (spec 002 contracts/realtime-events.md).
 * It reuses the typing presence (Redis, 30 s TTL, member `assistant`) and sends the same ephemeral
 * signals as staff typing: `typing` to the ticket's staff room and, in Auto-reply mode only,
 * `conversation.typing` to the customer. The turn job runs in the worker, which has no sockets, so
 * signals go through the Socket.IO Redis emitter (as the outbox relay does). Typing is a nicety: any
 * failure is logged and ignored, and the heartbeat plus the TTL clear it if the job dies.
 */
@Injectable()
export class AssistantTyping implements OnApplicationShutdown {
  private readonly logger = new Logger('AssistantTyping');
  private redis?: Redis;
  private emitter?: Emitter;

  constructor(private readonly presence: PresenceService) {}

  /** Runs `work` with the indicator on, and turns it off afterwards, whatever happens. */
  async while<T>(target: TypingTarget, work: () => Promise<T>): Promise<T> {
    await this.signal(target, 'start');
    const heartbeat = setInterval(() => void this.signal(target, 'start'), HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await work();
    } finally {
      clearInterval(heartbeat);
      await this.signal(target, 'stop');
    }
  }

  private async signal(target: TypingTarget, state: 'start' | 'stop'): Promise<void> {
    const { tenantId } = target.ctx;
    try {
      // Presence also feeds the customer's "replying" status, so it follows what the customer may see.
      if (target.showToCustomer) await this.presence.typing(tenantId, target.ticketId, ASSISTANT_PRESENCE_MEMBER, state);
      const emitter = this.connect();
      emitter
        .of(STAFF_NAMESPACE)
        .to(roomFor(tenantId, `ticket:${target.ticketId}`))
        .emit(EPHEMERAL_EVENT, { type: 'typing', stream: `ticket:${target.ticketId}`, data: { ticketId: target.ticketId, user: { kind: 'assistant', name: 'Assistant' }, state } });
      if (target.showToCustomer) {
        emitter
          .of(CUSTOMER_NAMESPACE)
          .to(roomFor(tenantId, `conversation:${target.customerId}`))
          .emit(EPHEMERAL_EVENT, { type: 'conversation.typing', stream: 'conversation', data: { name: 'Assistant', avatarUrl: null, state, isAi: true } });
      }
    } catch (error) {
      this.logger.warn(`Typing signal failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private connect(): Emitter {
    if (this.emitter === undefined) {
      this.redis = createRedis(redisUrl(), 'ai-typing');
      this.emitter = new Emitter(this.redis);
    }
    return this.emitter;
  }

  onApplicationShutdown(): void {
    this.redis?.disconnect();
  }
}
