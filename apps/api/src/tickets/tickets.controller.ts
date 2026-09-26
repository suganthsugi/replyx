import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { TicketQueryService } from './ticket-query.service.js';
import { TicketsService } from './tickets.service.js';

import type { TicketDto, TicketSummaryDto } from './ticket-dto.js';
import type { Request } from 'express';

/**
 * Ticket listing, updates and deletion (contracts/tickets.yaml `/tickets`, `/tickets/{id}`). The
 * route permission is the registry key (`ticket.view`/`ticket.edit`/`ticket.delete`); per-ticket
 * or per-group refinement (view/edit/delete on the group, create on a destination group) happens
 * in the services, so an invisible ticket or view is 404 and a visible one without the right flag
 * is 403.
 */

const IdParams = z.object({ id: z.uuid() }).strict();

const TicketState = z.enum(['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed']);
const Priority = z.enum(['low', 'normal', 'high', 'urgent']);

/** `style: form, explode: false` (contracts/tickets.yaml): one query value, comma-separated. */
function commaSeparated<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => (typeof value === 'string' ? value.split(',') : value), z.array(item));
}

const ListQuery = z
  .object({
    ...paginationQuery,
    viewId: z.uuid().optional(),
    state: commaSeparated(TicketState).optional(),
    priority: commaSeparated(Priority).optional(),
    groupId: z.string().min(1).optional(),
    ownerId: z.string().min(1).optional(),
    customerId: z.uuid().optional(),
    sort: z
      .enum(['updated_at', '-updated_at', 'created_at', '-created_at', 'priority', '-priority', 'last_customer_message_at', '-last_customer_message_at'])
      .optional(),
  })
  .strict();

const PatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    state: TicketState.optional(),
    pendingUntil: z.iso.datetime().nullable().optional(),
    priority: Priority.optional(),
    groupId: z.uuid().nullable().optional(),
    ownerId: z.uuid().nullable().optional(),
    tagIds: z.array(z.uuid()).optional(),
  })
  .strict();

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly query: TicketQueryService,
  ) {}

  @Get()
  @RequirePermission('ticket.view')
  list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<Page<TicketSummaryDto>> {
    return this.query.list(tenantContextOf(req), query);
  }

  @Patch(':id')
  @RequirePermission('ticket.edit')
  update(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(PatchBody)) body: z.infer<typeof PatchBody>,
  ): Promise<TicketDto> {
    return this.tickets.update(tenantContextOf(req), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('ticket.delete')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<void> {
    await this.tickets.delete(tenantContextOf(req), params.id);
  }
}
