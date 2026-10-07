import { Module } from '@nestjs/common';

import { MessagingHttpModule } from '../messaging/messaging.module.js';
import { TicketsHttpModule } from '../tickets/tickets.module.js';

import { MacroApplyController } from './macro-apply.controller.js';
import { MacroApplyService } from './macro-apply.service.js';
import { MacrosController } from './macros.controller.js';
import { MacrosService } from './macros.service.js';

/**
 * Macros (US14, api process only): CRUD and `POST /tickets/{id}/apply-macro`. Applying reuses
 * `TicketsService` (field changes) and `StaffMessagesService` (the reply), which their modules
 * export; `TagsService` comes from the global `TagsModule`.
 */
@Module({
  imports: [TicketsHttpModule, MessagingHttpModule],
  controllers: [MacrosController, MacroApplyController],
  providers: [MacrosService, MacroApplyService],
})
export class MacrosHttpModule {}
