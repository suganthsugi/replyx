import { Module } from '@nestjs/common';

import { RealtimeModule } from '../platform-kernel/realtime/gateway.js';

import { ConversationTyping, CustomerTypingGateway, StaffTypingGateway } from './conversation-events.js';
import { CustomerConversationService } from './customer-conversation.service.js';
import { CustomerMessageRouter } from './customer-message-router.js';
import { CustomerController } from './customer.controller.js';
import { StaffMessagesController } from './staff-messages.controller.js';
import { StaffMessagesService } from './staff-messages.service.js';
import { NoRoutingRouter, TICKET_ROUTER } from './ticket-router.js';

/**
 * Messaging (research D9, D10): the conversation router and the customer thread. The ticket
 * router binding is replaced by the rule-based router in US11.
 */
@Module({
  providers: [CustomerMessageRouter, { provide: TICKET_ROUTER, useClass: NoRoutingRouter }],
  exports: [CustomerMessageRouter, TICKET_ROUTER],
})
export class MessagingModule {}

/** HTTP side of messaging (api process only). */
@Module({
  imports: [MessagingModule, RealtimeModule],
  controllers: [CustomerController, StaffMessagesController],
  providers: [CustomerConversationService, StaffMessagesService, ConversationTyping, StaffTypingGateway, CustomerTypingGateway],
  exports: [CustomerConversationService],
})
export class MessagingHttpModule {}
