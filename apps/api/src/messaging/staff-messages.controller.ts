import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { paginationQuery, type Page } from '../platform-kernel/http/pagination.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MAX_ATTACHMENTS, MessageBody } from './customer.controller.js';
import { StaffMessagesService, type MentionCandidateDto } from './staff-messages.service.js';

import type { MessageDto } from './message-dto.js';
import type { TicketDto } from '../tickets/ticket-dto.js';
import type { Request } from 'express';

/**
 * Staff reads of a ticket and its timeline, and replies and notes (contracts/tickets.yaml
 * `/tickets/{id}`, `/tickets/{id}/messages`). The route permission is the registry key; the
 * group check (view or edit on the ticket's group) happens in the service, so a ticket outside
 * the caller's groups is 404 and a visible ticket without edit is 403.
 */

const IdParams = z.object({ id: z.uuid() }).strict();

const MessagesQuery = z
  .object({
    ...paginationQuery,
    // Merged timelines arrive with merge (US14); accepted now so clients can send it.
    includeMerged: z.enum(['true', 'false']).optional(),
  })
  .strict();

const MentionQuery = z.object({ q: z.string().trim().max(80).default('') }).strict();

const PostBody = z
  .object({
    visibility: z.enum(['public', 'internal']),
    body: MessageBody,
    clientMessageId: z.uuid(),
    attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
    mentionIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict();

@Controller('tickets')
export class StaffMessagesController {
  constructor(private readonly messages: StaffMessagesService) {}

  @Get(':id')
  @RequirePermission('ticket.view')
  ticket(@Req() req: Request, @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>): Promise<TicketDto> {
    return this.messages.ticket(tenantContextOf(req), params.id);
  }

  @Get(':id/messages')
  @RequirePermission('ticket.view')
  list(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Query(new ZodValidationPipe(MessagesQuery)) query: z.infer<typeof MessagesQuery>,
  ): Promise<Page<MessageDto>> {
    return this.messages.messages(tenantContextOf(req), params.id, query);
  }

  /** Composer @mention picker: needs `ticket.edit`, and edit on the ticket's group (checked in the service). */
  @Get(':id/mention-candidates')
  @RequirePermission('ticket.edit')
  async mentionCandidates(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Query(new ZodValidationPipe(MentionQuery)) query: z.infer<typeof MentionQuery>,
  ): Promise<{ items: MentionCandidateDto[] }> {
    return { items: await this.messages.mentionCandidates(tenantContextOf(req), params.id, query.q) };
  }

  /** 201 with the message; a repeated `clientMessageId` returns the original. */
  @Post(':id/messages')
  @RequirePermission('ticket.edit')
  post(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(PostBody)) body: z.infer<typeof PostBody>,
  ): Promise<MessageDto> {
    return this.messages.post(tenantContextOf(req), params.id, body);
  }
}
