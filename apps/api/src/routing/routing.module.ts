import { Module } from '@nestjs/common';

import { RoutingRulesController } from './routing-rules.controller.js';
import { RoutingRulesService } from './routing-rules.service.js';
import { RuleBasedRouter } from './rule-based-router.js';
import { RoutingEvaluator } from './rule-evaluator.service.js';

/**
 * Routing rules (US11). Exports the rule-based `TicketRouter` and the evaluator that the
 * dry-run endpoint shares. Imports nothing from messaging at runtime: `MessagingModule` imports
 * this module and binds `TICKET_ROUTER` to `RuleBasedRouter`. `TagsService` comes from the global
 * `TagsModule`.
 */
@Module({
  providers: [RoutingEvaluator, RuleBasedRouter],
  exports: [RoutingEvaluator, RuleBasedRouter],
})
export class RoutingModule {}

/** HTTP side of routing rules (api process only). */
@Module({
  imports: [RoutingModule],
  controllers: [RoutingRulesController],
  providers: [RoutingRulesService],
})
export class RoutingHttpModule {}
