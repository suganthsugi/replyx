import { Module } from '@nestjs/common';

import { BusinessHoursController } from './business-hours.controller.js';
import { BusinessHoursService } from './business-hours.service.js';
import { SlaPoliciesController } from './sla-policies.controller.js';
import { SlaPoliciesService } from './sla-policies.service.js';
import { SlaReapplyService } from './sla-reapply.service.js';
import { SlaRecomputeService } from './sla-recompute.service.js';
import { SlaConsumer } from './sla.consumer.js';

/**
 * SLA (research D15). `SlaModule` exports the recompute service for other modules' use;
 * `SlaHttpModule` is the api-only admin surface for business-hours calendars and SLA policies
 * (T224), which recompute open tickets after an edit; `SlaJobsModule` is the worker-only consumer
 * (jobs.module.ts discovers it and routes its event types to the `sla` queue). The sweeper half
 * lives in `tickets/sweeper.job.ts`.
 */
@Module({ providers: [SlaRecomputeService], exports: [SlaRecomputeService] })
export class SlaModule {}

@Module({
  imports: [SlaModule],
  controllers: [BusinessHoursController, SlaPoliciesController],
  providers: [BusinessHoursService, SlaPoliciesService, SlaReapplyService],
})
export class SlaHttpModule {}

@Module({ imports: [SlaModule], providers: [SlaConsumer] })
export class SlaJobsModule {}
