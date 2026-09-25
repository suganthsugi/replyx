import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { routeNotFound } from '../../authorization/permission.guard.js';
import { OperatorApi, Public } from '../../authorization/registry/module-permissions.js';
import { PASSWORD_MAX_LENGTH } from '../../identity/password.service.js';
import { clearCsrfCookie, issueCsrfCookie } from '../../platform-kernel/http/csrf.guard.js';
import { RateLimit } from '../../platform-kernel/http/rate-limit.js';
import { ZodValidationPipe } from '../../platform-kernel/http/validation.pipe.js';

import { OperatorSessionService } from './operator-session.service.js';

import type { Request, Response } from 'express';

/**
 * Operator sign-in and sign-out on the console host (contracts/platform.yaml `/auth/*`). The
 * sign-in route is `@Public()` but only reachable on the console host: the console serves no
 * tenant, so there is nothing else there to authenticate against.
 */

const SignInBody = z
  .object({
    email: z.email().max(254).transform((email) => email.toLowerCase()),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export interface OperatorMeDto {
  id: string;
  email: string;
  name: string;
}

/** The permission guard hides operator routes from tenant hosts; a public route needs its own check. */
function consoleOnly(req: Request): void {
  if (req.hostKind !== 'console') throw routeNotFound();
}

@Controller('platform/auth')
export class OperatorAuthController {
  constructor(private readonly sessions: OperatorSessionService) {}

  /** Sets `rx_op_session` (HttpOnly) and `rx_csrf`, and returns the operator. */
  @Post('sign-in')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(200)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(SignInBody)) body: z.infer<typeof SignInBody>,
  ): Promise<OperatorMeDto> {
    consoleOnly(req);
    const userAgent = req.headers['user-agent'];
    const { token, principal } = await this.sessions.signIn(body.email, body.password, {
      ip: req.ip ?? null,
      userAgent: userAgent ?? null,
    });
    this.sessions.setCookie(res, token);
    issueCsrfCookie(res);
    req.operator = { operatorId: principal.operatorId, sessionId: principal.sessionId };
    return { id: principal.operatorId, email: principal.email, name: principal.name };
  }

  @Post('sign-out')
  @OperatorApi()
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (req.operator !== undefined) await this.sessions.revoke(req.operator.sessionId);
    this.sessions.clearCookie(res);
    clearCsrfCookie(res);
  }
}
