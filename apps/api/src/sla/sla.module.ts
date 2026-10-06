import { Module } from '@nestjs/common';

import { SlaRecomputeService } from './sla-recompute.service.js';
import { SlaConsumer } from './sla.consumer.js';

/**
 * SLA (research D15). `SlaModule` exports the recompute service for other modules' use (the
 * policy and business-hours admin services call it after an edit, T224); `SlaJobsModule` is the
 * worker-only consumer (jobs.module.ts discovers it and routes its event types to the `sla`
 * queue). The sweeper half lives in `tickets/sweeper.job.ts`.
 */
@Module({ providers: [SlaRecomputeService], exports: [SlaRecomputeService] })
export class SlaModule {}

@Module({ imports: [SlaModule], providers: [SlaConsumer] })
export class SlaJobsModule {}
