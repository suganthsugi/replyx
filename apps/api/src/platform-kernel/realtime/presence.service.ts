import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import { Clock } from '../clock.js';
import { REDIS } from '../redis/redis.module.js';

/**
 * Ephemeral presence (research D8, realtime-events rule 7): who is viewing or typing on a ticket,
 * and staff availability. Lives only in Redis with a 30 s heartbeat TTL; never written to the
 * database, the outbox or ticket history. Keys always include the tenant.
 *
 * Viewing and typing are per-ticket sorted sets scored by the last heartbeat, so a client that
 * disappears without saying goodbye drops out after 30 s. Availability is one key per user.
 * The gateway handlers that broadcast these arrive with the stories that use them (T111, T143,
 * T238). Redis errors degrade to "nobody present" rather than failing the caller.
 */

export const PRESENCE_TTL_MS = 30_000;

export type Availability = 'online' | 'away' | 'offline';
export type PresenceKind = 'viewing' | 'typing';

/** A staff user id, or `customer:{id}` for a customer typing in the conversation. */
export type PresenceMember = string;

export interface TicketPresence {
  viewers: PresenceMember[];
  typing: PresenceMember[];
}

function ticketKey(tenantId: string, ticketId: string, kind: PresenceKind): string {
  return `presence:${tenantId}:ticket:${ticketId}:${kind}`;
}

function availabilityKey(tenantId: string, userId: string): string {
  return `presence:${tenantId}:availability:${userId}`;
}

@Injectable()
export class PresenceService {
  private readonly logger = new Logger('PresenceService');

  constructor(
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** `enter` or a heartbeat keeps the member present for 30 s; `leave` removes it now. */
  async viewing(tenantId: string, ticketId: string, member: PresenceMember, state: 'enter' | 'leave'): Promise<TicketPresence> {
    await this.touch(ticketKey(tenantId, ticketId, 'viewing'), member, state === 'enter');
    return this.ticket(tenantId, ticketId);
  }

  /** `start` (repeated as a heartbeat while typing) or `stop`. */
  async typing(tenantId: string, ticketId: string, member: PresenceMember, state: 'start' | 'stop'): Promise<TicketPresence> {
    await this.touch(ticketKey(tenantId, ticketId, 'typing'), member, state === 'start');
    return this.ticket(tenantId, ticketId);
  }

  /** Members seen within the last 30 s, oldest first. */
  async ticket(tenantId: string, ticketId: string): Promise<TicketPresence> {
    const since = this.clock.nowMs() - PRESENCE_TTL_MS;
    try {
      const [viewers, typing] = await Promise.all([
        this.redis.zrangebyscore(ticketKey(tenantId, ticketId, 'viewing'), `(${since}`, '+inf'),
        this.redis.zrangebyscore(ticketKey(tenantId, ticketId, 'typing'), `(${since}`, '+inf'),
      ]);
      return { viewers, typing };
    } catch (error) {
      this.warn(error);
      return { viewers: [], typing: [] };
    }
  }

  /** Staff heartbeat; missing heartbeats read as `offline` after 30 s. */
  async setAvailability(tenantId: string, userId: string, availability: Availability): Promise<void> {
    try {
      if (availability === 'offline') await this.redis.del(availabilityKey(tenantId, userId));
      else await this.redis.set(availabilityKey(tenantId, userId), availability, 'PX', PRESENCE_TTL_MS);
    } catch (error) {
      this.warn(error);
    }
  }

  async availability(tenantId: string, userIds: readonly string[]): Promise<Map<string, Availability>> {
    const result = new Map<string, Availability>(userIds.map((id) => [id, 'offline']));
    if (userIds.length === 0) return result;
    try {
      const values = await this.redis.mget(...userIds.map((id) => availabilityKey(tenantId, id)));
      values.forEach((value, index) => {
        if (value === 'online' || value === 'away') result.set(userIds[index] as string, value);
      });
    } catch (error) {
      this.warn(error);
    }
    return result;
  }

  private async touch(key: string, member: PresenceMember, present: boolean): Promise<void> {
    const now = this.clock.nowMs();
    try {
      const multi = this.redis.multi().zremrangebyscore(key, '-inf', now - PRESENCE_TTL_MS);
      if (present) multi.zadd(key, now, member).pexpire(key, PRESENCE_TTL_MS);
      else multi.zrem(key, member);
      await multi.exec();
    } catch (error) {
      this.warn(error);
    }
  }

  private warn(error: unknown): void {
    this.logger.warn(`Presence unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
