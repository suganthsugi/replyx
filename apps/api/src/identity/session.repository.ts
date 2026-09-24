import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { SessionKind } from './session.service.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

export interface NewSession {
  userId: string;
  tokenHash: Buffer;
  kind: SessionKind;
  trustedDevice: boolean;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/** Session rows for one tenant; the base class adds `tenant_id` to every statement. */
export class SessionRepository extends TenantRepository {
  async insert(tx: TenantTransaction, session: NewSession): Promise<string> {
    const row = await this.insertInto(tx, 'sessions', {
      user_id: session.userId,
      token_hash: session.tokenHash,
      kind: session.kind,
      trusted_device: session.trustedDevice,
      last_seen_at: session.lastSeenAt,
      expires_at: session.expiresAt,
      ip: session.ip,
      user_agent: session.userAgent,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The session and its user's status, for authentication. */
  findByTokenHash(tx: TenantTransaction, tokenHash: Buffer) {
    return this.selectFrom(tx, 'sessions')
      .innerJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'sessions.tenant_id').onRef('users.id', '=', 'sessions.user_id'),
      )
      .select([
        'sessions.id',
        'sessions.user_id',
        'sessions.kind',
        'sessions.trusted_device',
        'sessions.last_seen_at',
        'sessions.expires_at',
        'users.status as user_status',
        'users.kind as user_kind',
      ])
      .where('sessions.token_hash', '=', tokenHash)
      .executeTakeFirst();
  }

  async touch(tx: TenantTransaction, sessionId: string, lastSeenAt: Date, expiresAt: Date): Promise<void> {
    await this.updateTable(tx, 'sessions')
      .set({ last_seen_at: lastSeenAt, expires_at: expiresAt })
      .where('id', '=', sessionId)
      .execute();
  }

  deleteById(tx: TenantTransaction, sessionId: string) {
    return this.deleteFrom(tx, 'sessions').where('id', '=', sessionId).returning(['id', 'user_id']).execute();
  }

  deleteAllForUser(tx: TenantTransaction, userId: string) {
    return this.deleteFrom(tx, 'sessions').where('user_id', '=', userId).returning('id').execute();
  }
}
