import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, unauthenticated, validationFailed } from '../platform-kernel/http/app-error.js';
import { tenantUrl } from '../platform-kernel/http/public-url.js';
import { MailQueue } from '../platform-kernel/mail/mail.service.js';

import { PasswordService } from './password.service.js';
import { hashToken, SessionService, type SessionPrincipal } from './session.service.js';

import type { AuthRequestInfo } from './staff-auth.service.js';

/**
 * Customer sign-in (FR-010, FR-012, contracts/customer.yaml `/customer/auth/*`, `/customer/me`).
 *
 * - A sign-in link request always answers the same (202). An active customer gets a single-use
 *   link valid for 15 minutes; requesting a new one supersedes older unused links. When the email
 *   is new and the tenant allows self-registration, the customer is created first (role
 *   Customer). Staff emails never get customer links.
 * - Redeeming signs in (trusted device by default, 30-day session) and uses the link up.
 * - Customers may set a password and then also sign in with it (StaffAuthService.signIn with
 *   `kind: 'customer'`, same lockout and identical 401s).
 */

export const SIGN_IN_LINK_TTL_MS = 15 * 60_000;

export function linkInvalidOrExpired(): AppError {
  return new AppError('LINK_INVALID_OR_EXPIRED', 400, 'This sign-in link is invalid or has expired. Request a new one');
}

export interface CustomerMeDto {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  hasPassword: boolean;
  emailOnReply: boolean;
}

export interface CustomerMeUpdate {
  name?: string;
  avatarAttachmentId?: string | null;
  newPassword?: string;
  currentPassword?: string;
  emailOnReply?: boolean;
}

@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly mail: MailQueue,
    private readonly clock: Clock,
  ) {}

  /** Always resolves; see the class comment for who gets an email. */
  async requestSignInLink(info: AuthRequestInfo, email: string, name: string | undefined): Promise<void> {
    const ctx = systemContext(info);
    const token = randomBytes(32).toString('base64url');
    const created = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new CustomerAuthRepository(ctx);
      let user = await repo.userByEmail(tx, email);
      if (user === undefined) {
        const settings = await repo.settings(tx);
        if (!settings.self_registration) return undefined;
        user = await repo.createCustomer(tx, email, name ?? defaultName(email));
        await this.audit.record(
          tx,
          { action: 'user.self_registered', resourceType: 'user', resourceId: user.id },
          { actor: { kind: 'user', id: user.id } },
        );
      }
      if (user.kind !== 'customer' || user.status !== 'active') return undefined;

      const now = this.clock.nowMs();
      await repo.supersedeLinks(tx, user.id, new Date(now));
      const linkId = await repo.insertLink(tx, user.id, hashToken(token), new Date(now + SIGN_IN_LINK_TTL_MS));
      return { linkId, user, workspaceName: await repo.tenantName(tx) };
    });
    if (created === undefined) return;

    // After commit: the job carries the token.
    await this.mail.enqueue(
      {
        tenantId: info.tenant.id,
        to: created.user.email,
        template: 'sign-in-link',
        workspaceName: created.workspaceName,
        vars: { name: created.user.name, url: tenantUrl(info.tenant.slug, `/sign-in/redeem?token=${token}`) },
      },
      { dedupeKey: `sign-in-link.${created.linkId}` },
    );
  }

  /** Uses a link and creates a customer session; 400 `LINK_INVALID_OR_EXPIRED` otherwise. */
  async redeem(info: AuthRequestInfo, token: string, trustDevice: boolean): Promise<{ token: string; principal: SessionPrincipal }> {
    const ctx = systemContext(info);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new CustomerAuthRepository(ctx);
      const now = this.clock.now();
      const link = await repo.openLink(tx, hashToken(token), now);
      if (link === undefined) throw linkInvalidOrExpired();
      await repo.useLink(tx, link.id, now);
      await repo.markSignedIn(tx, link.user_id, now);
      const session = await this.sessions.create(tx, {
        userId: link.user_id,
        kind: 'customer',
        trustedDevice: trustDevice,
        ip: info.ip,
        userAgent: info.userAgent,
      });
      await this.audit.record(
        tx,
        { action: 'auth.sign_in', resourceType: 'user', resourceId: link.user_id, details: { method: 'link' } },
        { actor: { kind: 'user', id: link.user_id } },
      );
      return session;
    });
  }

  async me(ctx: TenantContext): Promise<CustomerMeDto> {
    const userId = userIdOf(ctx);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const row = await new CustomerAuthRepository(ctx).me(tx, userId);
      if (row === undefined) throw unauthenticated();
      return toDto(row);
    });
  }

  /** Name, avatar, password and reply emails. Changing the password ends the other sessions. */
  async update(ctx: TenantContext, sessionId: string, input: CustomerMeUpdate): Promise<CustomerMeDto> {
    const userId = userIdOf(ctx);
    const newHash = input.newPassword === undefined ? undefined : await this.passwords.hash(input.newPassword);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new CustomerAuthRepository(ctx);
      const current = await repo.me(tx, userId);
      if (current === undefined) throw unauthenticated();

      if (newHash !== undefined) {
        if (current.password_hash !== null) {
          const ok = await this.passwords.verify(current.password_hash, input.currentPassword ?? '');
          if (!ok) throw validationFailed([{ path: 'currentPassword', issue: 'incorrect' }]);
        }
        await repo.setPassword(tx, userId, newHash);
        await this.sessions.revokeOthersForUser(tx, userId, sessionId);
        await this.audit.record(tx, { action: 'user.password_changed', resourceType: 'user', resourceId: userId });
      }
      if (input.name !== undefined || input.avatarAttachmentId !== undefined) {
        await repo.updateUser(tx, userId, { name: input.name, avatarAttachmentId: input.avatarAttachmentId });
      }
      if (input.emailOnReply !== undefined) await repo.setEmailOnReply(tx, userId, input.emailOnReply);

      const updated = await repo.me(tx, userId);
      if (updated === undefined) throw unauthenticated();
      return toDto(updated);
    });
  }
}

function toDto(row: {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
  email_on_reply: boolean | null;
}): CustomerMeDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    // Attachments (and avatar URLs) arrive with the attachments module.
    avatarUrl: null,
    hasPassword: row.password_hash !== null,
    emailOnReply: row.email_on_reply ?? true,
  };
}

function defaultName(email: string): string {
  return (email.split('@')[0] ?? email).slice(0, 120) || 'Customer';
}

function userIdOf(ctx: TenantContext): string {
  if (ctx.actor.kind !== 'user') throw new Error('Customer routes need a user actor');
  return ctx.actor.id;
}

function systemContext(info: AuthRequestInfo): TenantContext {
  return TenantContext.create({ tenantId: info.tenant.id, actor: { kind: 'system' }, requestId: info.requestId, ip: info.ip });
}

class CustomerAuthRepository extends TenantRepository {
  userByEmail(tx: TenantTransaction, email: string) {
    return this.selectFrom(tx, 'users')
      .select(['id', 'email', 'name', 'kind', 'status'])
      .where('email', '=', email)
      .executeTakeFirst();
  }

  settings(tx: TenantTransaction) {
    return this.selectFrom(tx, 'tenant_settings').select('self_registration').executeTakeFirstOrThrow();
  }

  async createCustomer(tx: TenantTransaction, email: string, name: string) {
    const user = await this.insertInto(tx, 'users', { email, name, kind: 'customer', status: 'active' })
      .returning(['id', 'email', 'name', 'kind', 'status'])
      .executeTakeFirstOrThrow();
    const role = await this.selectFrom(tx, 'roles').select('id').where('system_key', '=', 'customer').executeTakeFirstOrThrow();
    await this.insertInto(tx, 'user_roles', { user_id: user.id, role_id: role.id }).execute();
    await this.insertInto(tx, 'customer_profiles', { user_id: user.id }).execute();
    return user;
  }

  async supersedeLinks(tx: TenantTransaction, userId: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'sign_in_links')
      .set({ superseded_at: at })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('superseded_at', 'is', null)
      .execute();
  }

  async insertLink(tx: TenantTransaction, userId: string, tokenHash: Buffer, expiresAt: Date): Promise<string> {
    const row = await this.insertInto(tx, 'sign_in_links', { user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** An unused, not superseded, unexpired link of an active customer (row locked). */
  openLink(tx: TenantTransaction, tokenHash: Buffer, now: Date) {
    return this.selectFrom(tx, 'sign_in_links')
      .innerJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'sign_in_links.tenant_id').onRef('users.id', '=', 'sign_in_links.user_id'),
      )
      .select(['sign_in_links.id', 'sign_in_links.user_id'])
      .where('sign_in_links.token_hash', '=', tokenHash)
      .where('sign_in_links.used_at', 'is', null)
      .where('sign_in_links.superseded_at', 'is', null)
      .where('sign_in_links.expires_at', '>', now)
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'customer')
      .forUpdate()
      .executeTakeFirst();
  }

  async useLink(tx: TenantTransaction, linkId: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'sign_in_links').set({ used_at: at }).where('id', '=', linkId).execute();
  }

  async markSignedIn(tx: TenantTransaction, userId: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'users').set({ last_sign_in_at: at }).where('id', '=', userId).execute();
  }

  async tenantName(tx: TenantTransaction): Promise<string> {
    const row = await tx.selectFrom('tenants').select('name').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return row.name;
  }

  me(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users')
      .leftJoin('customer_profiles', (join) =>
        join.onRef('customer_profiles.tenant_id', '=', 'users.tenant_id').onRef('customer_profiles.user_id', '=', 'users.id'),
      )
      .select(['users.id', 'users.name', 'users.email', 'users.password_hash', 'customer_profiles.email_on_reply'])
      .where('users.id', '=', userId)
      .where('users.kind', '=', 'customer')
      .executeTakeFirst();
  }

  async setPassword(tx: TenantTransaction, userId: string, passwordHash: string): Promise<void> {
    await this.updateTable(tx, 'users').set({ password_hash: passwordHash }).where('id', '=', userId).execute();
  }

  async updateUser(tx: TenantTransaction, userId: string, input: { name?: string; avatarAttachmentId?: string | null }) {
    await this.updateTable(tx, 'users')
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.avatarAttachmentId === undefined ? {} : { avatar_attachment_id: input.avatarAttachmentId }),
      })
      .where('id', '=', userId)
      .execute();
  }

  async setEmailOnReply(tx: TenantTransaction, userId: string, emailOnReply: boolean): Promise<void> {
    await this.insertInto(tx, 'customer_profiles', { user_id: userId, email_on_reply: emailOnReply })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ email_on_reply: emailOnReply }))
      .execute();
  }
}
