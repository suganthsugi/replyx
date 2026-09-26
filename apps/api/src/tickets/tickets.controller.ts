import { Body, Controller, Delete, HttpCode, Param, Patch, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { TicketsService } from './tickets.service.js';

import type { TicketDto } from './ticket-dto.js';
import type { Request } from 'express';

/**
 * Ticket updates and deletion (contracts/tickets.yaml `/tickets/{id}` PATCH/DELETE). The route
 * permission is the registry key (`ticket.edit`/`ticket.delete`); the per-group check (edit or
 * delete on the ticket's current group, create on a destination group) happens in the service, so
 * an invisible ticket is 404 and a visible one without the right flag is 403.
 */

const IdParams = z.object({ id: z.uuid() }).strict();

const TicketState = z.enum(['new', 'open', 'pending_reminder', 'pending_close', 'resolved', 'closed']);
const Priority = z.enum(['low', 'normal', 'high', 'urgent']);

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
  constructor(private readonly tickets: TicketsService) {}

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
