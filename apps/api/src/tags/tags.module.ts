import { Global, Module } from '@nestjs/common';

import { TagsController } from './tags.controller.js';
import { TagsService } from './tags.service.js';

/**
 * `TagsService` is used both by the tags HTTP controller and by other modules that need to
 * validate or read tag sets (tickets, customers). Global so those modules can inject it without
 * importing this module directly (same pattern as `TicketsModule`, tickets.module.ts).
 */
@Global()
@Module({ providers: [TagsService], exports: [TagsService] })
export class TagsModule {}

/** HTTP side of tags (api process only, contracts/tickets.yaml `/tags*`). */
@Module({ controllers: [TagsController] })
export class TagsHttpModule {}
