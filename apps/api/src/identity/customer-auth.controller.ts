import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { CustomerApi, Public } from '../authorization/registry/module-permissions.js';
import { clearCsrfCookie, issueCsrfCookie } from '../platform-kernel/http/csrf.guard.js';
import { RateLimit } from '../platform-kernel/http/rate-limit.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';
import { ZodValidationPipe } from '../platform-kernel/http/validation.pipe.js';

import { CustomerAuthService, type CustomerMeDto } from './customer-auth.service.js';
import { PASSWORD_MAX_LENGTH } from './password.service.js';
import { CUSTOMER_TRUSTED_IDLE_MS, SessionService, type SessionPrincipal } from './session.service.js';
import { authRequestInfo, PASSWORD_MIN_LENGTH } from './staff-auth.controller.js';
import { StaffAuthService } from './staff-auth.service.js';

import type { Request, Response } from 'express';

/** Customer sign-in and profile (contracts/customer.yaml `/customer/auth/*`, `/customer/me`). */

const Email = z.email().max(254).transform((email) => email.toLowerCase());

const SignInLinkBody = z.object({ email: Email, name: z.string().trim().min(1).max(120).optional() }).strict();

const RedeemBody = z.object({ token: z.string().min(1).max(200), trustDevice: z.boolean().default(true) }).strict();

const PasswordSignInBody = z
  .object({
    email: Email,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    trustDevice: z.boolean().default(true),
  })
  .strict();

const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Avatars need the attachments module; until then only clearing is accepted.
    avatarAttachmentId: z.null().optional(),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
    currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
    emailOnReply: z.boolean().optional(),
  })
  .strict();

function sessionIdOf(req: Request): string {
  if (req.actor === undefined) throw new Error('Route needs an authenticated actor');
  return req.actor.sessionId;
}

@Controller('customer')
export class CustomerAuthController {
  constructor(
    private readonly customers: CustomerAuthService,
    private readonly staffAuth: StaffAuthService,
    private readonly sessions: SessionService,
  ) {}

  /** Always 202, whether or not a link was sent. */
  @Post('auth/sign-in-link')
  @Public()
  @RateLimit('sign-in-link')
  @HttpCode(202)
  async requestSignInLink(@Req() req: Request, @Body(new ZodValidationPipe(SignInLinkBody)) body: z.infer<typeof SignInLinkBody>) {
    await this.customers.requestSignInLink(authRequestInfo(req), body.email, body.name);
  }

  @Post('auth/sign-in-link/redeem')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(200)
  async redeem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(RedeemBody)) body: z.infer<typeof RedeemBody>,
  ): Promise<CustomerMeDto> {
    const session = await this.customers.redeem(authRequestInfo(req), body.token, body.trustDevice);
    return this.startSession(req, res, session);
  }

  @Post('auth/sign-in')
  @Public()
  @RateLimit('sign-in')
  @HttpCode(200)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(PasswordSignInBody)) body: z.infer<typeof PasswordSignInBody>,
  ): Promise<CustomerMeDto> {
    const session = await this.staffAuth.signIn(authRequestInfo(req), body.email, body.password, {
      kind: 'customer',
      trustDevice: body.trustDevice,
    });
    return this.startSession(req, res, session);
  }

  @Post('auth/sign-out')
  @CustomerApi()
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.staffAuth.signOut(tenantContextOf(req), sessionIdOf(req));
    this.sessions.clearCookie(res);
    clearCsrfCookie(res);
  }

  @Post('auth/sign-out-all')
  @CustomerApi()
  @HttpCode(204)
  async signOutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const ctx = tenantContextOf(req);
    await this.staffAuth.signOutAll(ctx, req.actor?.userId ?? '');
    this.sessions.clearCookie(res);
    clearCsrfCookie(res);
  }

  @Get('me')
  @CustomerApi()
  me(@Req() req: Request): Promise<CustomerMeDto> {
    return this.customers.me(tenantContextOf(req));
  }

  @Patch('me')
  @CustomerApi()
  update(@Req() req: Request, @Body(new ZodValidationPipe(UpdateMeBody)) body: z.infer<typeof UpdateMeBody>): Promise<CustomerMeDto> {
    return this.customers.update(tenantContextOf(req), sessionIdOf(req), body);
  }

  private startSession(req: Request, res: Response, session: { token: string; principal: SessionPrincipal }) {
    const { token, principal } = session;
    this.sessions.setCookie(res, token, principal);
    // Same lifetime as the session cookie: trusted devices keep both across browser restarts.
    issueCsrfCookie(res, principal.trustedDevice ? CUSTOMER_TRUSTED_IDLE_MS / 1000 : undefined);
    req.actor = { kind: 'customer', userId: principal.userId, sessionId: principal.sessionId };
    return this.customers.me(tenantContextOf(req));
  }
}
