import { Global, Module } from '@nestjs/common';

import { USER_OWNERSHIP_CHECKS, type UserHistoryCheck } from '../identity/users.service.js';
import { tenantScopeOf, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

import { DefaultViewsContributor } from './default-views.contributor.js';
import { ViewCompiler } from './view-compiler.js';
import { ViewCountsService } from './view-counts.service.js';
import { ViewsController } from './views.controller.js';
import { ViewsRepository } from './views.repository.js';
import { ViewsService } from './views.service.js';

/**
 * `ViewCompiler` is also provided directly in `tickets/tickets.module.ts` (`TicketsHttpModule`),
 * which needs it for `GET /tickets?viewId=`, and in the worker's `ViewsJobsModule`
 * (counts-notifier.ts); it holds no per-request state (just `PolicyService`), so the extra
 * instances are harmless.
 */
/**
 * A user who created a view shared with other staff cannot be hard-deleted: `views_owner_fk` is
 * ON DELETE CASCADE, so the delete would silently remove the view for everyone it is shared with.
 * Personal views still go with their owner.
 */
export class ViewOwnerHistory implements UserHistoryCheck {
  readonly message = 'This user owns views shared with other staff. Deactivate them, or delete those views first';

  hasHistory(tx: TenantTransaction, userId: string): Promise<boolean> {
    const ctx = tenantScopeOf(tx);
    if (ctx === undefined) throw new Error('View queries must run inside withTenant');
    return new ViewsRepository(ctx).ownsSharedView(tx, userId);
  }
}

/** Global so `UsersService` resolves `USER_OWNERSHIP_CHECKS` in either process (same as `TicketsModule`). */
@Global()
@Module({
  providers: [{ provide: USER_OWNERSHIP_CHECKS, useFactory: () => [new ViewOwnerHistory()] }],
  exports: [USER_OWNERSHIP_CHECKS],
})
export class ViewsOwnershipModule {}

@Module({
  controllers: [ViewsController],
  providers: [ViewsService, ViewCompiler, ViewCountsService, DefaultViewsContributor],
})
export class ViewsModule {}
