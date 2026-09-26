import { Module } from '@nestjs/common';

import { DefaultViewsContributor } from './default-views.contributor.js';
import { ViewCompiler } from './view-compiler.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

/**
 * `ViewCompiler` is also provided directly in `tickets/tickets.module.ts` (`TicketsHttpModule`),
 * which needs it for `GET /tickets?viewId=`; it holds no per-request state (just `PolicyService`),
 * so a second instance here is harmless. Leave that one alone — consolidating the two providers
 * into one shared module is a later cleanup, not part of this task.
 */
@Module({
  controllers: [ViewsController],
  providers: [ViewsService, ViewCompiler, DefaultViewsContributor],
})
export class ViewsModule {}
