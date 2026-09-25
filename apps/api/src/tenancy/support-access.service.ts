import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, notFound } from '../platform-kernel/http/app-error.js';
import { SUPPORT_TOKEN_HEADER } from '../platform-kernel/http/cookies.js';

import type { TenantContext } from '../platform-kernel/db/tenant-context.js';

/**
 * Time-limited read-only access for platform operators (FR-001a, data-model.md
 * "support_access_grants"). A tenant admin grants it; nobody at the platform can grant it to
 * themselves. An active grant is `revoked_at IS NULL AND now() BETWEEN starts_at AND expires_at`.
 *
 * The support token an operator receives is a signed statement, not a stored session:
 * `v1.{base64url(payload)}.{base64url(hmac)}`, signed with `SESSION_SECRET` over the tenant, the
 * grant, the operator and the expiry. Nothing about it can be forged, and it is still worthless
 * on its own: every request re-reads the grant, so revoking one ends access on the next call.
 * It travels in the `X-Support-Token` header rather than a cookie, because the console and the
 * tenant are different hosts and a read-only header needs no CSRF pairing.
 */

export { SUPPORT_TOKEN_HEADER };

export const MIN_GRANT_HOURS = 1;
/** 7 days, the ceiling the table's CHECK also enforces. */
export const MAX_GRANT_HOURS = 168;

export interface SupportGrantDto {
  id: string;
  reason: string | null;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  grantedBy: { id: string; name: string } | null;
  revokedBy: { id: string; name: string } | null;
}

export interface SupportTokenClaims {
  tenantId: string;
  grantId: string;
  operatorId: string;
  /** Epoch milliseconds; never later than the grant's expiry. */
  expiresAt: number;
}

export function readOnlySupportAccess(): AppError {
  return new AppError('READ_ONLY_SUPPORT_ACCESS', 403, 'Support access is read-only');
}

export function supportAccessNotGranted(): AppError {
  return new AppError('SUPPORT_ACCESS_NOT_GRANTED', 404, 'No active support access grant');
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (value === undefined || value === '') throw new Error('SESSION_SECRET is not set');
  return value;
}

function sign(payload: string): Buffer {
  return createHmac('sha256', secret()).update(payload).digest();
}

/** `v1.{payload}.{signature}`; both parts base64url, so the token is cookie- and header-safe. */
export function encodeSupportToken(claims: SupportTokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `v1.${payload}.${sign(payload).toString('base64url')}`;
}

/** The claims of a well-formed, correctly signed token, or undefined. Does not check the grant. */
export function decodeSupportToken(token: string | undefined): SupportTokenClaims | undefined {
  if (token === undefined || token.length > 2048) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  const [, payload, signature] = parts as [string, string, string];
  const expected = sign(payload);
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SupportTokenClaims>;
    if (
      typeof claims.tenantId !== 'string' ||
      typeof claims.grantId !== 'string' ||
      typeof claims.operatorId !== 'string' ||
      typeof claims.expiresAt !== 'number'
    ) {
      return undefined;
    }
    return { tenantId: claims.tenantId, grantId: claims.grantId, operatorId: claims.operatorId, expiresAt: claims.expiresAt };
  } catch {
    return undefined;
  }
}

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Newest first; the admin screen shows active and past grants together. */
  list(ctx: TenantContext): Promise<SupportGrantDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rows = await new SupportAccessRepository(ctx).list(tx);
      return rows.map((row) => this.toDto(row));
    });
  }

  /** `durationHours` 1–168, counted from now. The table's CHECK is the backstop. */
  async create(ctx: TenantContext, input: { durationHours: number; reason?: string }): Promise<SupportGrantDto> {
    const grantedBy = userIdOf(ctx);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + input.durationHours * 3_600_000);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SupportAccessRepository(ctx);
      const id = await repo.insert(tx, {
        granted_by: grantedBy,
        reason: input.reason ?? null,
        starts_at: now,
        expires_at: expiresAt,
      });
      await this.audit.record(tx, {
        action: 'support_access.granted',
        resourceType: 'support_access_grant',
        resourceId: id,
        details: { durationHours: input.durationHours, expiresAt: expiresAt.toISOString() },
      });
      const row = await repo.byId(tx, id);
      if (row === undefined) throw notFound('support_access_grant');
      return this.toDto(row);
    });
  }

  /** Ends the grant now; an already revoked or expired grant is returned unchanged. */
  async revoke(ctx: TenantContext, grantId: string): Promise<SupportGrantDto> {
    const revokedBy = userIdOf(ctx);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new SupportAccessRepository(ctx);
      const existing = await repo.byId(tx, grantId);
      if (existing === undefined) throw notFound('support_access_grant');
      if (existing.revoked_at === null) {
        await repo.revoke(tx, grantId, this.clock.now(), revokedBy);
        await this.audit.record(tx, {
          action: 'support_access.revoked',
          resourceType: 'support_access_grant',
          resourceId: grantId,
        });
      }
      const row = await repo.byId(tx, grantId);
      if (row === undefined) throw notFound('support_access_grant');
      return this.toDto(row);
    });
  }

  /** The tenant's active grant with the latest expiry, or undefined. */
  activeGrant(ctx: TenantContext): Promise<{ id: string; expires_at: Date } | undefined> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) =>
      new SupportAccessRepository(ctx).activeGrant(tx, this.clock.now()),
    );
  }

  /**
   * Issues a token for the tenant's active grant; 404 `SUPPORT_ACCESS_NOT_GRANTED` without one.
   * The token never outlives the grant.
   */
  async openSession(ctx: TenantContext, operatorId: string): Promise<{ token: string; expiresAt: Date }> {
    const grant = await this.activeGrant(ctx);
    if (grant === undefined) throw supportAccessNotGranted();
    const token = encodeSupportToken({
      tenantId: ctx.tenantId,
      grantId: grant.id,
      operatorId,
      expiresAt: grant.expires_at.getTime(),
    });
    await this.unitOfWork.withTenant(ctx, (tx) =>
      this.audit.record(tx, {
        action: 'support_access.session_opened',
        resourceType: 'support_access_grant',
        resourceId: grant.id,
        details: { expiresAt: grant.expires_at.toISOString() },
      }),
    );
    return { token, expiresAt: grant.expires_at };
  }

  /**
   * Whether the token's grant is still usable right now. Called on every support request, which
   * is what makes revocation immediate.
   */
  async grantIsActive(ctx: TenantContext, grantId: string): Promise<boolean> {
    const row = await this.unitOfWork.withTenantReadOnly(ctx, (tx) =>
      new SupportAccessRepository(ctx).activeById(tx, grantId, this.clock.now()),
    );
    return row !== undefined;
  }

  /** One audit row per support read, with the path but never any content (FR-001a). */
  async recordRead(ctx: TenantContext, details: { method: string; path: string; grantId: string }): Promise<void> {
    await this.unitOfWork.withTenant(ctx, (tx) =>
      this.audit.record(tx, {
        action: 'support_access.read',
        resourceType: 'support_access_grant',
        resourceId: details.grantId,
        details: { method: details.method, path: details.path },
      }),
    );
  }

  private toDto(row: GrantRow): SupportGrantDto {
    const now = this.clock.nowMs();
    return {
      id: row.id,
      reason: row.reason,
      startsAt: row.starts_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      active: row.revoked_at === null && row.starts_at.getTime() <= now && row.expires_at.getTime() > now,
      grantedBy: row.granted_by === null ? null : { id: row.granted_by, name: row.granted_by_name ?? 'Former user' },
      revokedBy: row.revoked_by === null ? null : { id: row.revoked_by, name: row.revoked_by_name ?? 'Former user' },
    };
  }
}

function userIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw readOnlySupportAccess();
  return ctx.actor.id;
}

type GrantRow = Awaited<ReturnType<SupportAccessRepository['byId']>> & object;

class SupportAccessRepository extends TenantRepository {
  private base(tx: TenantTransaction) {
    return this.selectFrom(tx, 'support_access_grants')
      .leftJoin('users as granter', (join) =>
        join
          .onRef('granter.tenant_id', '=', 'support_access_grants.tenant_id')
          .onRef('granter.id', '=', 'support_access_grants.granted_by'),
      )
      .leftJoin('users as revoker', (join) =>
        join
          .onRef('revoker.tenant_id', '=', 'support_access_grants.tenant_id')
          .onRef('revoker.id', '=', 'support_access_grants.revoked_by'),
      )
      .select([
        'support_access_grants.id',
        'support_access_grants.reason',
        'support_access_grants.starts_at',
        'support_access_grants.expires_at',
        'support_access_grants.revoked_at',
        'support_access_grants.granted_by',
        'support_access_grants.revoked_by',
        'granter.name as granted_by_name',
        'revoker.name as revoked_by_name',
      ]);
  }

  list(tx: TenantTransaction) {
    return this.base(tx).orderBy('support_access_grants.created_at', 'desc').limit(100).execute();
  }

  byId(tx: TenantTransaction, grantId: string) {
    return this.base(tx).where('support_access_grants.id', '=', grantId).executeTakeFirst();
  }

  async insert(
    tx: TenantTransaction,
    values: { granted_by: string; reason: string | null; starts_at: Date; expires_at: Date },
  ): Promise<string> {
    const row = await this.insertInto(tx, 'support_access_grants', values).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  async revoke(tx: TenantTransaction, grantId: string, at: Date, by: string): Promise<void> {
    await this.updateTable(tx, 'support_access_grants')
      .set({ revoked_at: at, revoked_by: by })
      .where('id', '=', grantId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  activeGrant(tx: TenantTransaction, now: Date) {
    return this.selectFrom(tx, 'support_access_grants')
      .select(['id', 'expires_at'])
      .where('revoked_at', 'is', null)
      .where('starts_at', '<=', now)
      .where('expires_at', '>', now)
      .orderBy('expires_at', 'desc')
      .executeTakeFirst();
  }

  activeById(tx: TenantTransaction, grantId: string, now: Date) {
    return this.selectFrom(tx, 'support_access_grants')
      .select('id')
      .where('id', '=', grantId)
      .where('revoked_at', 'is', null)
      .where('starts_at', '<=', now)
      .where('expires_at', '>', now)
      .executeTakeFirst();
  }
}
