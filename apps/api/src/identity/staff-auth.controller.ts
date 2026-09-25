import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { Public, StaffApi } from '../authorization/registry/module-permissions.js';
import { clearCsrfCookie, issueCsrfCookie } from '../platform-kernel/http/csrf.guard.js';
import { RateLimit } from '../platform-kernel/http/rate-limit.js';
import { requestIdOf, tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { MeService, type MeDto } from './me.service.js';
import { PASSWORD_MAX_LENGTH } from './password.service.js';
import { SessionService } from './session.service.js';
import { StaffAuthService, type AuthRequestInfo } from './staff-auth.service.js';

import type { Request, Response } from 'express';

/** Staff authentication routes (contracts/identity.yaml `/auth/*`). */

export const PASSWORD_MIN_LENGTH = 12;

const Email = z.email().max(254).transform((email) => email.toLowerCase());

const SignInBody = z
  .object({
    email: Email,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

const PasswordResetBody = z.object({ email: Email }).strict();

const PasswordResetConfirmBody = z
  .object({
    token: z.string().min(1).max(200),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

/** What the auth services need from a request on a tenant host (tenant, request id, client). */
export function authRequestInfo(req: Request): AuthRequestInfo {
  if (req.tenant === undefined) throw new Error('Auth routes need a resolved tenant');
  const userAgent = req.headers['user-agent'];
  return { tenant: req.tenant, requestId: requestIdOf(req), ip: req.ip ?? null, userAgent: userAgent ?? null };
}

function actorOf(req: Request) {
  if (req.actor === undefined) throw new Error('Route needs an authenticated actor');
  return req.actor;
}

@Controller('auth')
export class StaffAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly sessions: SessionService,
    private readonly me: MeService,
  ) {}

  /** Sets `rx_session` (HttpOnly) and `rx_csrf` (readable by the web client) and returns `Me`. */
  @Post('sign-in')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(200)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(SignInBody)) body: z.infer<typeof SignInBody>,
  ): Promise<MeDto> {
    const { token, principal } = await this.auth.signIn(authRequestInfo(req), body.email, body.password);
    this.sessions.setCookie(res, token, principal);
    issueCsrfCookie(res);
    // The request had no actor; answer as the user who just signed in.
    req.actor = { kind: 'staff', userId: principal.userId, sessionId: principal.sessionId };
    return this.me.me(tenantContextOf(req));
  }

  @Post('sign-out')
  @StaffApi()
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.signOut(tenantContextOf(req), actorOf(req).sessionId);
    this.sessions.clearCookie(res);
    clearCsrfCookie(res);
  }

  @Post('sign-out-all')
  @StaffApi()
  @HttpCode(204)
  async signOutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.signOutAll(tenantContextOf(req), actorOf(req).userId);
    this.sessions.clearCookie(res);
    clearCsrfCookie(res);
  }

  /** Always 202, whether or not the email belongs to anyone. */
  @Post('password-reset')
  @Public()
  @RateLimit('sign-in-link')
  @HttpCode(202)
  async requestPasswordReset(
    @Req() req: Request,
    @Body(new ZodValidationPipe(PasswordResetBody)) body: z.infer<typeof PasswordResetBody>,
  ): Promise<void> {
    await this.auth.requestPasswordReset(authRequestInfo(req), body.email);
  }

  @Post('password-reset/confirm')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(204)
  async confirmPasswordReset(
    @Req() req: Request,
    @Body(new ZodValidationPipe(PasswordResetConfirmBody)) body: z.infer<typeof PasswordResetConfirmBody>,
  ): Promise<void> {
    await this.auth.confirmPasswordReset(authRequestInfo(req), body.token, body.password);
  }
}
