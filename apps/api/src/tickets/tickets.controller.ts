import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { MAX_ATTACHMENTS, MessageBody } from '../messaging/customer.controller.js';
import { validationFailed } from '../platform-kernel/http/app-error.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { toDetails, ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MessageMoveService } from './message-move.service.js';
import { StaffStartedTicketService } from './staff-started-ticket.service.js';
import { TicketHistoryQueryService, type HistoryEntryDto } from './ticket-history-query.service.js';
import { TicketQueryService } from './ticket-query.service.js';
import { TicketsService } from './tickets.service.js';

import type { TicketDto, TicketSummaryDto } from './ticket-dto.js';
import type { MessageDto } from '../messaging/message-dto.js';
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
    number: z.coerce.number().int().positive().optional(),
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

const CreateBody = z
  .object({
    customerId: z.uuid(),
    groupId: z.uuid(),
    title: z.string().min(1).max(200),
    message: z.object({ body: MessageBody, attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]) }).strict(),
    ownerId: z.uuid().optional(),
    priority: Priority.optional(),
    tagIds: z.array(z.uuid()).optional(),
  })
  .strict();

const HistoryQuery = z.object({ ...paginationQuery }).strict();

const MoveMessageParams = z.object({ id: z.uuid(), messageId: z.uuid() }).strict();
const MoveMessageBody = z.object({ targetTicketId: z.uuid() }).strict();

const IdempotencyKeyHeader = z.string().min(1).max(100).optional();

/** `@Headers()` has no pipe overload (unlike `@Body`/`@Query`/`@Param`), so this validates by hand. */
function idempotencyKeyOf(value: string | undefined): string | undefined {
  const result = IdempotencyKeyHeader.safeParse(value);
  if (!result.success) throw validationFailed(toDetails(result.error.issues, value));
  return result.data;
}

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly query: TicketQueryService,
    private readonly staffStarted: StaffStartedTicketService,
    private readonly historyQuery: TicketHistoryQueryService,
    private readonly messageMove: MessageMoveService,
  ) {}

  @Get()
  @RequirePermission('ticket.view')
  list(@Req() req: Request, @Query(new ZodValidationPipe(ListQuery)) query: z.infer<typeof ListQuery>): Promise<Page<TicketSummaryDto>> {
    return this.query.list(tenantContextOf(req), query);
  }

  /** Start a ticket for an existing, active customer (FR-038a); skips routing. */
  @Post()
  @RequirePermission('ticket.create')
  @HttpCode(201)
  create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
  ): Promise<TicketDto> {
    return this.staffStarted.create(tenantContextOf(req), body, idempotencyKeyOf(idempotencyKeyHeader));
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

  @Get(':id/history')
  @RequirePermission('ticket.view')
  history(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Query(new ZodValidationPipe(HistoryQuery)) query: z.infer<typeof HistoryQuery>,
  ): Promise<Page<HistoryEntryDto>> {
    return this.historyQuery.list(tenantContextOf(req), params.id, query);
  }

  @Post(':id/messages/:messageId/move')
  @RequirePermission('ticket.move_message')
  @HttpCode(200)
  moveMessage(
    @Req() req: Request,
    @Param(new ZodValidationPipe(MoveMessageParams)) params: z.infer<typeof MoveMessageParams>,
    @Body(new ZodValidationPipe(MoveMessageBody)) body: z.infer<typeof MoveMessageBody>,
  ): Promise<MessageDto> {
    return this.messageMove.move(tenantContextOf(req), params.id, params.messageId, body.targetTicketId);
  }
}
