import { Inject, Injectable, Module, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../platform-kernel/clock.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../platform-kernel/jobs/idempotent-handler.js';

import type { UserKind } from '../platform-kernel/db/tables/identity.js';
import type { DomainEventType } from '../platform-kernel/outbox/event-types.js';

/**
 * Erases a user's personal data (FR-009, spec Assumptions), driven by `user.erasure_requested`
 * which `UsersService.requestErasure` appends after deactivating the user.
 *
 * Identity's own part is the same for both kinds: the account keeps its id (so audit entries and
 * ticket history stay linkable) and loses everything personal — name, email, avatar, password,
 * sign-in timestamps and the customer profile — plus every credential row (sessions, invitations,
 * sign-in links, password resets). `erased_at` marks the account and makes the erasure idempotent.
 *
 * What differs by kind lives in the modules that own the data, which register a
 * `UserErasureContributor`: a customer's tickets and messages are removed, while a staff user's
 * authored content stays and shows `Former user` (Tickets, US6). No contributor exists yet, so
 * today erasure touches identity only.
 */

/** The placeholder shown wherever an erased user's name would appear. */
export const ERASED_NAME = 'Former user';

/** The domain of the synthetic address an erased account keeps (`UNIQUE (tenant_id, email)`). */
const ERASED_EMAIL_DOMAIN = 'erased.invalid';

export interface ErasureTarget {
  userId: string;
  kind: UserKind;
}

/** Modules holding user-authored data erase or anonymise their own rows (never identity's). */
export interface UserErasureContributor {
  erase(tx: TenantTransaction, target: ErasureTarget): Promise<void>;
}

/** Multi-provider token: each module with user-authored data provides a contributor. */
export const USER_ERASURE_CONTRIBUTORS = Symbol('USER_ERASURE_CONTRIBUTORS');

@Injectable()
export class ErasureConsumer extends IdempotentHandler<'user.erasure_requested'> {
  readonly consumer = 'user-erasure';
  readonly queue = 'retention' as const;
  readonly eventTypes: readonly Extract<DomainEventType, 'user.erasure_requested'>[] = ['user.erasure_requested'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Optional() @Inject(USER_ERASURE_CONTRIBUTORS) private readonly contributors: UserErasureContributor[] = [],
  ) {
    super(unitOfWork);
  }

  protected async handle(tx: TenantTransaction, event: DomainEvent<'user.erasure_requested'>): Promise<void> {
    const { userId } = event.payload;
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('ErasureConsumer.handle must run inside withTenant');
    const repo = new ErasureRepository(ctx);
    const user = await repo.byId(tx, userId);
    // Deleted or already erased: nothing left to erase, and the audit entry was written then.
    if (user === undefined || user.erased_at !== null) return;

    for (const contributor of this.contributors) {
      await contributor.erase(tx, { userId, kind: user.kind });
    }

    await repo.anonymise(tx, userId, this.clock.now());
    await repo.deleteCredentials(tx, userId);
    await repo.deleteCustomerProfile(tx, userId);

    // Personal data must not survive in the audit log either: only the id and the kind.
    await this.audit.record(tx, {
      action: 'user.erased',
      resourceType: 'user',
      resourceId: userId,
      details: { kind: user.kind },
    });
  }
}

class ErasureRepository extends TenantRepository {
  byId(tx: TenantTransaction, userId: string) {
    return this.selectFrom(tx, 'users').select(['id', 'kind', 'erased_at']).where('id', '=', userId).executeTakeFirst();
  }

  async anonymise(tx: TenantTransaction, userId: string, now: Date): Promise<void> {
    await this.updateTable(tx, 'users')
      .set({
        name: ERASED_NAME,
        email: `erased-${userId}@${ERASED_EMAIL_DOMAIN}`,
        avatar_attachment_id: null,
        password_hash: null,
        status: 'deactivated',
        availability: 'offline',
        failed_sign_ins: 0,
        locked_until: null,
        last_sign_in_at: null,
        erased_at: now,
      })
      .where('id', '=', userId)
      .execute();
  }

  async deleteCredentials(tx: TenantTransaction, userId: string): Promise<void> {
    await this.deleteFrom(tx, 'sessions').where('user_id', '=', userId).execute();
    await this.deleteFrom(tx, 'user_invitations').where('user_id', '=', userId).execute();
    await this.deleteFrom(tx, 'sign_in_links').where('user_id', '=', userId).execute();
    await this.deleteFrom(tx, 'password_resets').where('user_id', '=', userId).execute();
  }

  async deleteCustomerProfile(tx: TenantTransaction, userId: string): Promise<void> {
    await this.deleteFrom(tx, 'customer_profiles').where('user_id', '=', userId).execute();
  }
}

/** Worker only: the api process has no job router, so the consumer lives in its own module. */
@Module({ providers: [ErasureConsumer] })
export class IdentityJobsModule {}
