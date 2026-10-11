import { Module } from '@nestjs/common';

import { MessagingModule } from '../../messaging/messaging.module.js';
import { DirectNotifier } from '../../notifications/direct-notifier.js';
import { TicketsService } from '../../tickets/tickets.service.js';

import { AutomationRulesController } from './automation-rules.controller.js';
import { AutomationRulesService } from './automation-rules.service.js';
import { AutomationRunJob } from './automation-run.job.js';
import { AutomationSweepJob } from './automation-sweep.job.js';
import { AutomationConsumer } from './automation.consumer.js';

/** Automation rules admin (api process only). */
@Module({ controllers: [AutomationRulesController], providers: [AutomationRulesService] })
export class AutomationHttpModule {}

/**
 * The automation engine (worker only; jobs.module.ts discovers the consumer and both processors).
 * Field changes go through its own `TicketsService` instance (as AI routing does), auto-replies
 * through `MessagingModule`'s `AutomationMessageWriter`; `TagsService` and `PolicyService` are
 * global.
 */
@Module({ imports: [MessagingModule], providers: [AutomationConsumer, AutomationRunJob, AutomationSweepJob, DirectNotifier, TicketsService] })
export class AutomationJobsModule {}
