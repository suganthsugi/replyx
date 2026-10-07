import { Module } from '@nestjs/common';

import { SearchController } from './search.controller.js';
import { PostgresSearchService, SearchService } from './search.service.js';

/** `GET /search` (api process only). The policy, unit of work and tags service come from global modules. */
@Module({
  controllers: [SearchController],
  providers: [{ provide: SearchService, useClass: PostgresSearchService }],
})
export class SearchHttpModule {}
