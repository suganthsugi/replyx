import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, validationFailed } from '../platform-kernel/http/app-error.js';
import { tenantUrl } from '../platform-kernel/http/public-url.js';
import { MailQueue } from '../platform-kernel/mail/mail.service.js';

import { accountLocked, LockoutService } from './lockout.service.js';
import { PasswordService } from './password.service.js';
import { hashToken, SessionService, type SessionKind, type SessionPrincipal } from './session.service.js';

import type { ResolvedTenant } from '../platform-kernel/http/request-context.js';

/**
 * Staff sign-in, sign-out and password reset (FR-008–FR-011, research D5, contracts/identity.yaml).
 *
 * - Sign-in answers the same 401 for an unknown email, a wrong password, and an invited or
 *   deactivated user, and spends the same argon2 time on each (PasswordService). A locked
 *   account answers 423 without checking the password; the failure that sets the lock also
 *   answers 423. Failures are audited (`auth.sign_in_failed`) even though the request fails.
 * - Password reset requests always look the same to the caller (202); only an active staff user
 *   gets an email, with a single-use link valid for 30 minutes. Confirming sets the password,
 *   clears any lockout and ends every session of the user.
 */

export const PASSWORD_RESET_TTL_MS = 30 * 60_000;

export interface AuthRequestInfo {
  tenant: ResolvedTenant;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export function invalidCredentials(): AppError {
  return new AppError('INVALID_CREDENTIALS', 401, 'Wrong email or password');
}

export function resetTokenInvalid(): AppError {
  return validationFailed([{ path: 'token', issue: 'invalid_or_expired' }]);
}

type SignInOutcome =
  | { kind: 'ok'; token: string; principal: SessionPrincipal }
  | { kind: 'failed' }
  | { kind: 'locked' };

@Injectable()
export class StaffAuthService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly lockout: LockoutService,
    private readonly audit: AuditService,
    private readonly mail: MailQueue,
    private readonly clock: Clock,
  ) {}

  /**
   * Password sign-in for `kind` users (customers who set a password use the same rules); throws
   * 401 `INVALID_CREDENTIALS` or 423 `ACCOUNT_LOCKED`.
   */
  async signIn(
    info: AuthRequestInfo,
    email: string,
    password: string,
    options: { kind?: SessionKind; trustDevice?: boolean } = {},
  ): Promise<{ token: string; principal: SessionPrincipal }> {
    const kind = options.kind ?? 'staff';
    const ctx = systemContext(info);
    // Failures are written (audit, lockout count) and committed before the error is thrown.
    const outcome = await this.unitOfWork.withTenant(ctx, async (tx): Promise<SignInOutcome> => {
      const repo = new StaffAuthRepository(ctx);
      const user = await repo.userByEmail(tx, email, kind);

      if (user !== undefined && this.lockout.isLocked(user)) {
        await this.recordFailure(tx, user.id, 'locked');
        return { kind: 'locked' };
      }
      const active = user?.status === 'active';
      const verified = await this.passwords.verify(active ? user.password_hash : null, password);
      if (user === undefined || !active || !verified) {
        const locked = active ? (await this.lockout.recordFailure(tx, user.id)).locked : false;
        await this.recordFailure(tx, user?.id ?? null, locked ? 'locked' : 'invalid_credentials');
        return { kind: locked ? 'locked' : 'failed' };
      }

      await this.lockout.recordSuccess(tx, user.id);
      const hash = user.password_hash;
      const rehash = hash !== null && this.passwords.needsRehash(hash) ? await this.passwords.hash(password) : undefined;
      await repo.markSignedIn(tx, user.id, this.clock.now(), rehash);
      const session = await this.sessions.create(tx, {
        userId: user.id,
        kind,
        trustedDevice: options.trustDevice,
        ip: info.ip,
        userAgent: info.userAgent,
      });
      await this.audit.record(
        tx,
        { action: 'auth.sign_in', resourceType: 'user', resourceId: user.id },
        { actor: { kind: 'user', id: user.id } },
      );
      return { kind: 'ok', ...session };
    });

    if (outcome.kind === 'locked') throw accountLocked();
    if (outcome.kind === 'failed') throw invalidCredentials();
    return { token: outcome.token, principal: outcome.principal };
  }

  /** Ends the current session. */
  async signOut(ctx: TenantContext, sessionId: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, (tx) => this.sessions.revoke(tx, sessionId, 'sign_out'));
  }

  /** Ends every session of the user (FR-011); their sockets disconnect. */
  async signOutAll(ctx: TenantContext, userId: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, (tx) => this.sessions.revokeAllForUser(tx, userId, 'sign_out_all'));
  }

  /** Always resolves; emails a reset link only to an active staff user. */
  async requestPasswordReset(info: AuthRequestInfo, email: string): Promise<void> {
    const ctx = systemContext(info);
    const token = randomBytes(32).toString('base64url');
    const created = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new StaffAuthRepository(ctx);
      const user = await repo.userByEmail(tx, email, 'staff');
      if (user?.status !== 'active') return undefined;
      const now = this.clock.nowMs();
      await repo.retireResets(tx, user.id, new Date(now));
      const resetId = await repo.insertReset(tx, user.id, hashToken(token), new Date(now + PASSWORD_RESET_TTL_MS));
      return { resetId, user, workspaceName: await repo.tenantName(tx) };
    });
    if (created === undefined) return;

    // After commit: the job carries the token, which is never stored in the outbox.
    await this.mail.enqueue(
      {
        tenantId: info.tenant.id,
        to: created.user.email,
        template: 'password-reset',
        workspaceName: created.workspaceName,
        vars: { name: created.user.name, url: tenantUrl(info.tenant.slug, `/desk/reset-password?token=${token}`) },
      },
      { dedupeKey: `password-reset.${created.resetId}` },
    );
  }

  /** Sets a new password with a reset token; 400 `VALIDATION_FAILED` (`token`) when unusable. */
  async confirmPasswordReset(info: AuthRequestInfo, token: string, password: string): Promise<void> {
    const ctx = systemContext(info);
    const passwordHash = await this.passwords.hash(password);
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new StaffAuthRepository(ctx);
      const reset = await repo.openReset(tx, hashToken(token), this.clock.now());
      if (reset === undefined) throw resetTokenInvalid();

      const now = this.clock.now();
      await repo.useReset(tx, reset.id, now);
      await repo.retireResets(tx, reset.user_id, now);
      await repo.setPassword(tx, reset.user_id, passwordHash);
      await this.lockout.recordSuccess(tx, reset.user_id);
      await this.sessions.revokeAllForUser(tx, reset.user_id, 'sign_out_all');
      await this.audit.record(
        tx,
        { action: 'auth.password_reset', resourceType: 'user', resourceId: reset.user_id },
        { actor: { kind: 'user', id: reset.user_id } },
      );
    });
  }

  private recordFailure(tx: TenantTransaction, userId: string | null, reason: 'locked' | 'invalid_credentials') {
    return this.audit.record(tx, { action: 'auth.sign_in_failed', resourceType: 'user', resourceId: userId, details: { reason } });
  }
}

function systemContext(info: AuthRequestInfo): TenantContext {
  return TenantContext.create({ tenantId: info.tenant.id, actor: { kind: 'system' }, requestId: info.requestId, ip: info.ip });
}

class StaffAuthRepository extends TenantRepository {
  userByEmail(tx: TenantTransaction, email: string, kind: SessionKind) {
    return this.selectFrom(tx, 'users')
      .select(['id', 'email', 'name', 'status', 'password_hash', 'locked_until'])
      .where('email', '=', email)
      .where('kind', '=', kind)
      .executeTakeFirst();
  }

  async markSignedIn(tx: TenantTransaction, userId: string, at: Date, rehash: string | undefined): Promise<void> {
    await this.updateTable(tx, 'users')
      .set({ last_sign_in_at: at, ...(rehash === undefined ? {} : { password_hash: rehash }) })
      .where('id', '=', userId)
      .execute();
  }

  async setPassword(tx: TenantTransaction, userId: string, passwordHash: string): Promise<void> {
    await this.updateTable(tx, 'users').set({ password_hash: passwordHash }).where('id', '=', userId).execute();
  }

  async tenantName(tx: TenantTransaction): Promise<string> {
    // `tenants` is global; the app role may read it.
    const row = await tx.selectFrom('tenants').select('name').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return row.name;
  }

  async insertReset(tx: TenantTransaction, userId: string, tokenHash: Buffer, expiresAt: Date): Promise<string> {
    const row = await this.insertInto(tx, 'password_resets', { user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** An unused, unexpired reset of an active staff user. */
  openReset(tx: TenantTransaction, tokenHash: Buffer, now: Date) {
    return this.selectFrom(tx, 'password_resets')
      .innerJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'password_resets.tenant_id').onRef('users.id', '=', 'password_resets.user_id'),
      )
      .select(['password_resets.id', 'password_resets.user_id'])
      .where('password_resets.token_hash', '=', tokenHash)
      .where('password_resets.used_at', 'is', null)
      .where('password_resets.expires_at', '>', now)
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .forUpdate()
      .executeTakeFirst();
  }

  async useReset(tx: TenantTransaction, resetId: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'password_resets').set({ used_at: at }).where('id', '=', resetId).execute();
  }

  /** Earlier unused links stop working when a new one is sent or one is used. */
  async retireResets(tx: TenantTransaction, userId: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'password_resets')
      .set({ used_at: at })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .execute();
  }
}
