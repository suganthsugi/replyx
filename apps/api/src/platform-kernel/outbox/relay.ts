import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';

import { PLATFORM_DB, type Database } from '../db/database.js';
import { JobRouter, JobsModule, type EventRoute } from '../jobs/jobs.module.js';
import { QueueRegistry } from '../jobs/queues.js';
import { runWithLogContext } from '../observability/logger.js';
import { MetricsService } from '../observability/metrics.js';
import { createRedis, redisUrl } from '../redis/redis.module.js';

import {
  clientStream,
  CONTROL_EVENT_TYPES,
  isCustomerProjection,
  isCustomerStream,
  isStreamKey,
  type DomainEventType,
  type EventActor,
} from './event-types.js';

import type { JsonValue } from '../db/tables/column-types.js';
import type { Redis } from 'ioredis';

/**
 * The outbox relay (research D7, worker process only). One leader, chosen with a session-level
 * advisory lock held by a dedicated connection that also `LISTEN`s on `outbox_new`, publishes
 * unpublished events in id order:
 *
 *   1. in one platform-pool transaction, lock a batch (`FOR UPDATE`), give each event the next
 *      `seq` (max + 1: a single writer, so gap-free in publish order) and set `published_at`;
 *   2. fan out: one BullMQ job per interested consumer, one Socket.IO emit per stream room
 *      (customer rooms get only the customer projection), and a server-side broadcast of
 *      control events to the gateways;
 *   3. commit.
 *
 * A crash before commit republishes the batch: jobs are deduplicated by job id and clients drop
 * envelopes whose `id` they already applied. Published events are kept 7 days for `sync`.
 */

/** Client-facing event name for persistent envelopes; ephemeral signals use their own names. */
export const ENVELOPE_EVENT = 'event';
/** Server-side broadcast the gateways listen to (T037/T039). */
export const CONTROL_EVENT = 'replyx:control';

export const STAFF_NAMESPACE = '/';
export const CUSTOMER_NAMESPACE = '/customer';

const RELAY_LOCK_KEY = 0x72656c61; // 'rela'
const POLL_MS = 500;
const LEADER_RETRY_MS = 5_000;
const BATCH_SIZE = 500;
const PRUNE_EVERY_MS = 10 * 60_000;
export const RETENTION_DAYS = 7;

export interface Envelope {
  id: string;
  seq: number;
  stream: string;
  type: string;
  occurredAt: string;
  /** Customer envelopes carry only the actor kind: no staff ids or names beyond the projection. */
  actor: EventActor | { kind: EventActor['kind'] };
  data: JsonValue;
}

export interface ControlMessage {
  id: string;
  seq: number;
  tenantId: string;
  type: DomainEventType;
  payload: JsonValue;
}

export interface RelayEvent {
  id: string;
  tenantId: string;
  type: string;
  actor: EventActor;
  payload: JsonValue;
  customerPayload: JsonValue | null;
  streams: string[];
  occurredAt: Date;
  seq: number;
}

export interface DeliveryPlan {
  jobs: readonly EventRoute[];
  emits: { namespace: string; room: string; envelope: Envelope }[];
  control?: ControlMessage;
}

/** Rooms are `t:{tenantId}:{stream}` (realtime-events rule 4). */
export function roomFor(tenantId: string, stream: string): string {
  return `t:${tenantId}:${stream}`;
}

/** What publishing one event means, without doing it. */
export function planDelivery(event: RelayEvent, routes: readonly EventRoute[]): DeliveryPlan {
  const emits: DeliveryPlan['emits'] = [];
  for (const stream of event.streams) {
    // `tenant` is a control stream for the gateways, never a room.
    if (!isStreamKey(stream) || stream === 'tenant') continue;
    const customer = isCustomerStream(stream);
    if (customer && !isCustomerProjection(event.customerPayload)) continue;
    const projection = customer && isCustomerProjection(event.customerPayload) ? event.customerPayload : undefined;
    emits.push({
      namespace: customer ? CUSTOMER_NAMESPACE : STAFF_NAMESPACE,
      room: roomFor(event.tenantId, stream),
      envelope: {
        id: event.id,
        seq: event.seq,
        stream: clientStream(stream),
        type: projection?.type ?? event.type,
        occurredAt: event.occurredAt.toISOString(),
        actor: projection === undefined ? event.actor : { kind: event.actor.kind },
        data: projection?.data ?? event.payload,
      },
    });
  }
  const control = CONTROL_EVENT_TYPES.has(event.type as DomainEventType)
    ? { id: event.id, seq: event.seq, tenantId: event.tenantId, type: event.type as DomainEventType, payload: event.payload }
    : undefined;
  return { jobs: routes, emits, ...(control === undefined ? {} : { control }) };
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OutboxRelay');
  private client?: pg.Client;
  private redis?: Redis;
  private emitter?: Emitter;
  private leader = false;
  private stopped = false;
  private running = false;
  private wakeRequested = false;
  private pollTimer?: NodeJS.Timeout;
  private leaderTimer?: NodeJS.Timeout;
  private lastPrune = 0;

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    private readonly router: JobRouter,
    private readonly queues: QueueRegistry,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    this.redis = createRedis(redisUrl(), 'emitter');
    this.emitter = new Emitter(this.redis);
    void this.tryLead();
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** Takes the advisory lock on a dedicated connection, or retries later. */
  async tryLead(): Promise<void> {
    if (this.stopped || this.leader) return;
    try {
      const client = new pg.Client({
        connectionString: requireEnv('DATABASE_URL_PLATFORM'),
        application_name: 'replyx-relay',
      });
      client.on('error', (error) => this.stepDown(`relay connection error: ${error.message}`));
      await client.connect();
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [RELAY_LOCK_KEY]);
      if (rows[0]?.locked !== true) {
        await client.end();
        this.scheduleLeaderRetry();
        return;
      }
      client.on('notification', () => this.wake());
      await client.query('LISTEN outbox_new');
      this.client = client;
      this.leader = true;
      this.logger.log('Outbox relay is the leader');
      this.pollTimer = setInterval(() => this.wake(), POLL_MS);
      this.wake();
    } catch (error) {
      this.logger.warn(`Relay could not take the lead: ${error instanceof Error ? error.message : 'unknown'}`);
      this.scheduleLeaderRetry();
    }
  }

  /** Coalesces wake-ups: one publish loop at a time, rerun if woken meanwhile. */
  wake(): void {
    if (!this.leader || this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      }
    });
  }

  private async drain(): Promise<void> {
    try {
      let published: number;
      do {
        published = await this.publishBatch();
      } while (published === BATCH_SIZE && this.leader && !this.stopped);
      await this.recordLag();
      await this.pruneIfDue();
    } catch (error) {
      this.logger.error(`Relay batch failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** Publishes one batch; returns how many events it published. */
  async publishBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox_events')
        .select(['id', 'tenant_id', 'type', 'actor', 'payload', 'customer_payload', 'streams', 'created_at'])
        .select(sql<number>`extract(epoch from clock_timestamp() - created_at)`.as('age_seconds'))
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(BATCH_SIZE)
        .forUpdate()
        .execute();
      if (rows.length === 0) return 0;

      const max = await trx
        .selectFrom('outbox_events')
        .select(sql<string | null>`max(seq)`.as('max'))
        .executeTakeFirstOrThrow();
      const first = Number(max.max ?? 0) + 1;
      const ids = rows.map((row) => row.id);
      await sql`
        UPDATE outbox_events AS o
        SET seq = ${first}::bigint + v.n - 1, published_at = now()
        FROM unnest(${sql.val(ids)}::uuid[]) WITH ORDINALITY AS v(id, n)
        WHERE o.id = v.id
      `.execute(trx);

      for (const [index, row] of rows.entries()) {
        const event: RelayEvent = {
          id: row.id,
          tenantId: row.tenant_id,
          type: row.type,
          actor: row.actor as unknown as EventActor,
          payload: row.payload,
          customerPayload: row.customer_payload,
          streams: row.streams,
          occurredAt: row.created_at,
          seq: first + index,
        };
        await runWithLogContext({ tenantId: event.tenantId, eventId: event.id }, () =>
          this.deliver(planDelivery(event, this.router.routesFor(event.type)), event),
        );
        this.metrics.realtimeDeliveryLag.record(Number(row.age_seconds));
      }
      return rows.length;
    });
  }

  private async deliver(plan: DeliveryPlan, event: RelayEvent): Promise<void> {
    for (const route of plan.jobs) {
      await this.queues.enqueueEvent(route.queue, route.consumer, { tenantId: event.tenantId, eventId: event.id });
    }
    const emitter = this.emitter;
    if (emitter === undefined) throw new Error('Relay emitter is not ready');
    for (const emit of plan.emits) {
      emitter.of(emit.namespace).to(emit.room).emit(ENVELOPE_EVENT, emit.envelope);
    }
    if (plan.control !== undefined) {
      emitter.serverSideEmit(CONTROL_EVENT, plan.control);
    }
  }

  private async recordLag(): Promise<void> {
    const row = await this.db
      .selectFrom('outbox_events')
      .select(sql<number | null>`extract(epoch from clock_timestamp() - min(created_at))`.as('lag'))
      .where('published_at', 'is', null)
      .executeTakeFirst();
    this.metrics.outboxRelayLag.record(Math.max(0, Number(row?.lag ?? 0)));
  }

  /** Deletes events published over 7 days ago, keeping the newest so `max(seq)` never goes back. */
  async pruneIfDue(): Promise<number> {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return 0;
    this.lastPrune = now;
    const result = await sql`
      DELETE FROM outbox_events
      WHERE published_at < now() - make_interval(days => ${RETENTION_DAYS})
        AND seq < (SELECT max(seq) FROM outbox_events)
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  private stepDown(reason: string): void {
    if (!this.leader && this.client === undefined) return;
    this.logger.warn(`Outbox relay stepping down: ${reason}`);
    this.leader = false;
    clearInterval(this.pollTimer);
    const client = this.client;
    this.client = undefined;
    void client?.end().catch(() => undefined);
    this.scheduleLeaderRetry();
  }

  private scheduleLeaderRetry(): void {
    if (this.stopped) return;
    clearTimeout(this.leaderTimer);
    this.leaderTimer = setTimeout(() => void this.tryLead(), LEADER_RETRY_MS);
    this.leaderTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.leader = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.leaderTimer);
    // Let an in-flight batch finish before the pools close.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
    await this.client?.end().catch(() => undefined);
    this.redis?.disconnect();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/** Worker process only. */
@Module({ imports: [JobsModule], providers: [OutboxRelay] })
export class OutboxRelayModule {}
