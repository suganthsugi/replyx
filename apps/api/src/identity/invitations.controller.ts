import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../authorization/registry/module-permissions.js';
import { issueCsrfCookie } from '../platform-kernel/http/csrf.guard.js';
import { RateLimit } from '../platform-kernel/http/rate-limit.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { InvitationsService } from './invitations.service.js';
import { MeService, type MeDto } from './me.service.js';
import { PASSWORD_MAX_LENGTH } from './password.service.js';
import { SessionService } from './session.service.js';
import { authRequestInfo, PASSWORD_MIN_LENGTH } from './staff-auth.controller.js';

import type { Request, Response } from 'express';

/** Invitation acceptance (contracts/identity.yaml `/invitations/{token}`); both routes are public. */

const TokenParams = z.object({ token: z.string().min(1).max(200) }).strict();

const AcceptBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly sessions: SessionService,
    private readonly me: MeService,
  ) {}

  @Get(':token')
  @Public()
  @RateLimit('sign-in')
  inspect(@Req() req: Request, @Param(new ZodValidationPipe(TokenParams)) params: z.infer<typeof TokenParams>) {
    return this.invitations.inspect(authRequestInfo(req), params.token);
  }

  /** Activates the account and signs in: sets `rx_session` and `rx_csrf`, returns `Me`. */
  @Post(':token/accept')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(200)
  async accept(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(TokenParams)) params: z.infer<typeof TokenParams>,
    @Body(new ZodValidationPipe(AcceptBody)) body: z.infer<typeof AcceptBody>,
  ): Promise<MeDto> {
    const { token, principal } = await this.invitations.accept(authRequestInfo(req), params.token, body);
    this.sessions.setCookie(res, token, principal);
    issueCsrfCookie(res);
    req.actor = { kind: 'staff', userId: principal.userId, sessionId: principal.sessionId };
    return this.me.me(tenantContextOf(req));
  }
}
