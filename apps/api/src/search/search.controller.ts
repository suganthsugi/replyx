import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { SearchService, type SearchResult } from './search.service.js';

import type { Request } from 'express';

/**
 * `GET /search` (contracts/tickets.yaml, FR-070): staff only (`ticket.view`); ticket results are
 * limited to groups the caller can view and customer results need `user.view` (search.service.ts).
 */

const SearchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    type: z.enum(['tickets', 'customers', 'all']).default('all'),
    ...paginationQuery,
  })
  .strict();

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermission('ticket.view')
  find(@Req() req: Request, @Query(new ZodValidationPipe(SearchQuery)) query: z.infer<typeof SearchQuery>): Promise<Page<SearchResult>> {
    return this.search.search(tenantContextOf(req), query);
  }
}
