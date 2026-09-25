import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { bumpAccessVersion } from '../authorization/access-version.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { tenantUrl } from '../platform-kernel/http/public-url.js';
import { MailQueue } from '../platform-kernel/mail/mail.service.js';
import { OutboxService } from '../platform-kernel/outbox/outbox.service.js';

import { PasswordService } from './password.service.js';
import { hashToken, SessionService, type SessionPrincipal } from './session.service.js';

import type { AuthRequestInfo } from './staff-auth.service.js';

/**
 * Staff invitations (FR-007, contracts/identity.yaml). Inviting creates (or reuses) an `invited`
 * user with their roles already assigned (they grant nothing until the user is active) and a
 * single pending invitation valid for 7 days; re-inviting replaces the pending one. Accepting sets
 * the name and password, activates the user and signs them in.
 *
 * Invitation emails are sent after the inviting transaction commits (`sendEmail`), because the
 * job carries the raw token.
 */

export const INVITATION_TTL_MS = 7 * 24 * 3_600_000;

export interface CreatedInvitation {
  invitationId: string;
  /** Raw token for the email link; never stored. */
  token: string;
  email: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailQueue,
    private readonly clock: Clock,
  ) {}

  /** Creates the pending invitation for an `invited` user in the caller's transaction. */
  async create(
    tx: TenantTransaction,
    input: { userId: string; email: string; roleIds: string[]; invitedBy: string | null },
  ): Promise<CreatedInvitation> {
    const repo = new InvitationsRepository(requireScope(tx));
    const token = randomBytes(32).toString('base64url');
    await repo.deletePending(tx, input.email);
    const invitationId = await repo.insert(tx, {
      user_id: input.userId,
      email: input.email,
      role_ids: input.roleIds,
      invited_by: input.invitedBy,
      token_hash: hashToken(token),
      expires_at: new Date(this.clock.nowMs() + INVITATION_TTL_MS),
    });
    return { invitationId, token, email: input.email };
  }

  /** Enqueues the invitation email; call after the inviting transaction has committed. */
  async sendEmail(
    tenant: { id: string; slug: string; name: string },
    invitation: CreatedInvitation,
    inviterName: string,
  ): Promise<void> {
    await this.mail.enqueue(
      {
        tenantId: tenant.id,
        to: invitation.email,
        template: 'invitation',
        workspaceName: tenant.name,
        vars: {
          tenantName: tenant.name,
          inviterName,
          url: tenantUrl(tenant.slug, `/desk/accept-invitation?token=${invitation.token}`),
        },
      },
      { dedupeKey: `invitation.${invitation.invitationId}` },
    );
  }

  /** `{ email, tenantName }` of a usable invitation; 404 `INVITATION_NOT_FOUND` otherwise. */
  async inspect(info: AuthRequestInfo, token: string): Promise<{ email: string; tenantName: string }> {
    const ctx = systemContext(info);
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new InvitationsRepository(ctx);
      const invitation = await repo.open(tx, hashToken(token), this.clock.now(), false);
      if (invitation === undefined) throw notFound('invitation');
      return { email: invitation.email, tenantName: await repo.tenantName(tx) };
    });
  }

  /** Activates the invited user with a name and password and creates their first session. */
  async accept(
    info: AuthRequestInfo,
    token: string,
    input: { name: string; password: string },
  ): Promise<{ token: string; principal: SessionPrincipal }> {
    const ctx = systemContext(info);
    const passwordHash = await this.passwords.hash(input.password);
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new InvitationsRepository(ctx);
      const now = this.clock.now();
      const invitation = await repo.open(tx, hashToken(token), now, true);
      if (invitation === undefined) throw notFound('invitation');

      await repo.markAccepted(tx, invitation.id, now);
      await repo.activate(tx, invitation.user_id, input.name, passwordHash, now);
      // An active user's roles now grant access.
      await bumpAccessVersion(tx, ctx.tenantId, 'user.activated', this.outbox);
      const session = await this.sessions.create(tx, {
        userId: invitation.user_id,
        kind: 'staff',
        ip: info.ip,
        userAgent: info.userAgent,
      });
      await this.audit.record(
        tx,
        { action: 'user.invitation_accepted', resourceType: 'user', resourceId: invitation.user_id },
        { actor: { kind: 'user', id: invitation.user_id } },
      );
      return session;
    });
  }
}

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('InvitationsService must run inside withTenant');
  return ctx;
}

function systemContext(info: AuthRequestInfo): TenantContext {
  return TenantContext.create({ tenantId: info.tenant.id, actor: { kind: 'system' }, requestId: info.requestId, ip: info.ip });
}

class InvitationsRepository extends TenantRepository {
  async deletePending(tx: TenantTransaction, email: string): Promise<void> {
    await this.deleteFrom(tx, 'user_invitations').where('email', '=', email).where('accepted_at', 'is', null).execute();
  }

  async insert(
    tx: TenantTransaction,
    row: {
      user_id: string;
      email: string;
      role_ids: string[];
      invited_by: string | null;
      token_hash: Buffer;
      expires_at: Date;
    },
  ): Promise<string> {
    const inserted = await this.insertInto(tx, 'user_invitations', row).returning('id').executeTakeFirstOrThrow();
    return inserted.id;
  }

  /** A pending, unexpired invitation whose user is still `invited`. */
  open(tx: TenantTransaction, tokenHash: Buffer, now: Date, lock: boolean) {
    const query = this.selectFrom(tx, 'user_invitations')
      .innerJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'user_invitations.tenant_id').onRef('users.id', '=', 'user_invitations.user_id'),
      )
      .select(['user_invitations.id', 'user_invitations.user_id', 'user_invitations.email'])
      .where('user_invitations.token_hash', '=', tokenHash)
      .where('user_invitations.accepted_at', 'is', null)
      .where('user_invitations.expires_at', '>', now)
      .where('users.status', '=', 'invited');
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }

  async markAccepted(tx: TenantTransaction, id: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'user_invitations').set({ accepted_at: at }).where('id', '=', id).execute();
  }

  async activate(tx: TenantTransaction, userId: string, name: string, passwordHash: string, at: Date): Promise<void> {
    await this.updateTable(tx, 'users')
      .set({ name, password_hash: passwordHash, status: 'active', last_sign_in_at: at })
      .where('id', '=', userId)
      .execute();
  }

  async tenantName(tx: TenantTransaction): Promise<string> {
    const row = await tx.selectFrom('tenants').select('name').where('id', '=', this.ctx.tenantId).executeTakeFirstOrThrow();
    return row.name;
  }
}
