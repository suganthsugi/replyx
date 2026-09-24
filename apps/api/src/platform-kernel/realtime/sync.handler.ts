import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { PLATFORM_DB, type Database } from '../db/database.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { validationFailed } from '../http/app-error.js';
import { ENVELOPE_EVENT, envelopeFor, type Envelope } from '../outbox/relay.js';

import { socketContext, type Ack, type RealtimeSocket } from './socket-context.js';
import { StreamAccess } from './stream-access.js';

import type { EventActor, StreamKey } from '../outbox/event-types.js';

/**
 * Reconnect catch-up (research D8, contracts/realtime-events.md `sync`). For each requested
 * stream the socket may see *now*, replays outbox events with `seq > afterSeq` as the same
 * envelopes the relay emits, in `seq` order, then acks `{ ok: true, upToSeq, resyncRequired }`.
 *
 * A stream lands in `resyncRequired` (client refetches over REST) when its cursor is older than
 * the oldest retained event (7 days, relay pruning) or its backlog is over `MAX_REPLAY`.
 * `upToSeq` is the newest published `seq` at the time of the read: the socket is already in its
 * rooms, so anything newer arrives live (clients drop duplicates by `id`).
 */

export const MAX_SYNC_STREAMS = 50;
export const MAX_REPLAY = 1_000;

export interface SyncRequest {
  streams: { stream: string; afterSeq: number }[];
}

export type SyncAck = Ack<{ upToSeq: number; resyncRequired: string[] }>;

/** Validates the untrusted `sync` payload. */
export function parseSyncRequest(body: unknown): SyncRequest {
  const streams = (body as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams) || streams.length === 0 || streams.length > MAX_SYNC_STREAMS) {
    throw validationFailed([{ path: 'streams', issue: 'invalid' }]);
  }
  return {
    streams: streams.map((entry: unknown, index) => {
      const { stream, afterSeq } = (entry ?? {}) as { stream?: unknown; afterSeq?: unknown };
      if (typeof stream !== 'string' || stream.length === 0 || stream.length > 64) {
        throw validationFailed([{ path: `streams.${index}.stream`, issue: 'invalid' }]);
      }
      const seq = typeof afterSeq === 'string' && /^\d+$/.test(afterSeq) ? Number(afterSeq) : afterSeq;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        throw validationFailed([{ path: `streams.${index}.afterSeq`, issue: 'invalid' }]);
      }
      return { stream, afterSeq: seq };
    }),
  };
}

@Injectable()
export class SyncHandler {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly access: StreamAccess,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
  ) {}

  async sync(socket: RealtimeSocket, body: unknown): Promise<SyncAck> {
    const request = parseSyncRequest(body);
    const ctx = socketContext(socket);

    // Resolve access first (it opens its own read transactions).
    const wanted: { stream: string; afterSeq: number; keys: StreamKey[] }[] = [];
    for (const { stream, afterSeq } of request.streams) {
      wanted.push({ stream, afterSeq, keys: await this.access.keysFor(socket, stream) });
    }

    // Global bounds (seq is assigned across tenants by the single relay), read through the
    // platform pool: RLS would limit the app role to this tenant's rows. Only numbers leave it.
    const bounds = await sql<{ min: string | null; max: string | null }>`
      SELECT min(seq)::text AS min, max(seq)::text AS max FROM outbox_events WHERE seq IS NOT NULL
    `.execute(this.platformDb);
    const minSeq = Number(bounds.rows[0]?.min ?? 0);
    const maxSeq = Number(bounds.rows[0]?.max ?? 0);

    const { upToSeq, resyncRequired, envelopes } = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const resync: string[] = [];
      const out: Envelope[] = [];
      for (const { stream, afterSeq, keys } of wanted) {
        if (keys.length === 0 || afterSeq >= maxSeq) continue;
        // `afterSeq` must be at least the event just before the oldest retained one.
        if (minSeq > 0 && afterSeq < minSeq - 1) {
          resync.push(stream);
          continue;
        }
        const rows = await tx
          .selectFrom('outbox_events')
          .select(['id', 'tenant_id', 'type', 'actor', 'payload', 'customer_payload', 'streams', 'created_at', 'seq'])
          .where('seq', '>', String(afterSeq))
          .where('seq', '<=', String(maxSeq))
          .where(sql<boolean>`streams && ${sql.val(keys)}::text[]`)
          .orderBy('seq')
          .limit(MAX_REPLAY + 1)
          .execute();
        if (rows.length > MAX_REPLAY) {
          resync.push(stream);
          continue;
        }
        const wantedKeys = new Set<string>(keys);
        for (const row of rows) {
          const event = {
            id: row.id,
            tenantId: row.tenant_id,
            type: row.type,
            actor: row.actor as unknown as EventActor,
            payload: row.payload,
            customerPayload: row.customer_payload,
            streams: row.streams,
            occurredAt: row.created_at,
            seq: Number(row.seq),
          };
          for (const key of row.streams) {
            if (!wantedKeys.has(key)) continue;
            const envelope = envelopeFor(event, key);
            if (envelope !== undefined) out.push(envelope);
          }
        }
      }
      return { upToSeq: maxSeq, resyncRequired: resync, envelopes: out };
    });

    envelopes.sort((a, b) => a.seq - b.seq);
    for (const envelope of envelopes) socket.emit(ENVELOPE_EVENT, envelope);
    return { ok: true, upToSeq, resyncRequired };
  }
}
