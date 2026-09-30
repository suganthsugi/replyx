import { Module } from '@nestjs/common';

import { RealtimeModule } from '../platform-kernel/realtime/gateway.js';
import { RoutingModule } from '../routing/routing.module.js';
import { RuleBasedRouter } from '../routing/rule-based-router.js';

import { ConversationTyping, CustomerTypingGateway, StaffTypingGateway } from './conversation-events.js';
import { CustomerConversationService } from './customer-conversation.service.js';
import { CustomerMessageRouter } from './customer-message-router.js';
import { CustomerController } from './customer.controller.js';
import { StaffMessagesController } from './staff-messages.controller.js';
import { StaffMessagesService } from './staff-messages.service.js';
import { TICKET_ROUTER } from './ticket-router.js';

/**
 * Messaging (research D9, D10): the conversation router and the customer thread. New tickets are
 * routed by the rule-based router (US11); a classifier can replace the `TICKET_ROUTER` binding.
 */
@Module({
  imports: [RoutingModule],
  providers: [CustomerMessageRouter, { provide: TICKET_ROUTER, useExisting: RuleBasedRouter }],
  exports: [CustomerMessageRouter, TICKET_ROUTER],
})
export class MessagingModule {}

/** HTTP side of messaging (api process only). */
@Module({
  imports: [MessagingModule, RealtimeModule],
  controllers: [CustomerController, StaffMessagesController],
  providers: [CustomerConversationService, StaffMessagesService, ConversationTyping, StaffTypingGateway, CustomerTypingGateway],
  exports: [CustomerConversationService, StaffMessagesService],
})
export class MessagingHttpModule {}
