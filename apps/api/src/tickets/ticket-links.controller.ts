import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { TicketLinksService } from './ticket-links.service.js';

import type { TicketLinkDto } from './ticket-dto.js';
import type { Request } from 'express';

/**
 * Links between tickets (contracts/tickets.yaml `/tickets/{id}/links*`, FR-042 area). The route
 * permission is `ticket.edit`; per-ticket group checks (edit here, view on the target) happen in
 * the service, so an invisible ticket is 404 and a visible one without the right flag is 403.
 */

const IdParams = z.object({ id: z.uuid() }).strict();
const LinkIdParams = z.object({ id: z.uuid(), linkId: z.uuid() }).strict();

const CreateBody = z
  .object({
    targetTicketId: z.uuid(),
    kind: z.enum(['follow_up_of', 'related', 'duplicate_of']),
  })
  .strict();

@Controller('tickets')
export class TicketLinksController {
  constructor(private readonly links: TicketLinksService) {}

  @Post(':id/links')
  @RequirePermission('ticket.edit')
  @HttpCode(201)
  create(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<TicketLinkDto> {
    return this.links.create(tenantContextOf(req), params.id, body);
  }

  @Delete(':id/links/:linkId')
  @RequirePermission('ticket.edit')
  @HttpCode(204)
  async delete(@Req() req: Request, @Param(new ZodValidationPipe(LinkIdParams)) params: z.infer<typeof LinkIdParams>): Promise<void> {
    await this.links.delete(tenantContextOf(req), params.id, params.linkId);
  }
}
