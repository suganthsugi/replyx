import { Module } from '@nestjs/common';

import { DefaultViewsContributor } from './default-views.contributor.js';
import { ViewCompiler } from './view-compiler.js';
import { ViewCountsService } from './view-counts.service.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

/**
 * `ViewCompiler` is also provided directly in `tickets/tickets.module.ts` (`TicketsHttpModule`),
 * which needs it for `GET /tickets?viewId=`, and in the worker's `ViewsJobsModule`
 * (counts-notifier.ts); it holds no per-request state (just `PolicyService`), so the extra
 * instances are harmless.
 */
@Module({
  controllers: [ViewsController],
  providers: [ViewsService, ViewCompiler, ViewCountsService, DefaultViewsContributor],
})
export class ViewsModule {}
