import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '../authorization/registry/module-permissions.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MacroApplyService } from './macro-apply.service.js';
import { ApplyMacroSchema, type ApplyMacroInput } from './macro-input.js';

import type { TicketDto } from '../tickets/ticket-dto.js';
import type { Request } from 'express';

const IdParams = z.object({ id: z.uuid() }).strict();

/**
 * `POST /tickets/{id}/apply-macro` (contracts/tickets.yaml). The route needs `ticket.edit`; the
 * service checks edit on the ticket's group, `macro.view` and that the macro is visible.
 */
@Controller('tickets')
export class MacroApplyController {
  constructor(private readonly applyService: MacroApplyService) {}

  @Post(':id/apply-macro')
  @RequirePermission('ticket.edit')
  @HttpCode(200)
  apply(
    @Req() req: Request,
    @Param(new ZodValidationPipe(IdParams)) params: z.infer<typeof IdParams>,
    @Body(new ZodValidationPipe(ApplyMacroSchema)) body: ApplyMacroInput,
  ): Promise<TicketDto> {
    return this.applyService.apply(tenantContextOf(req), params.id, body);
  }
}
