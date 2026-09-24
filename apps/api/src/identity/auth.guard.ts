import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { routeAccessOf } from '../authorization/registry/module-permissions.js';
import { unauthenticated } from '../platform-kernel/http/app-error.js';
import { parseCookies, SESSION_COOKIE } from '../platform-kernel/http/cookies.js';
import { assignLogContext } from '../platform-kernel/observability/logger.js';

import { SessionService } from './session.service.js';

import type { Request } from 'express';

/**
 * Authentication step of the pipeline (constitution II, research D5): runs after the tenant is
 * resolved from the host. Reads the `rx_session` cookie, requires that the session belongs to
 * `req.tenant` and that its user is active, and sets `req.actor`. Anything else is 401
 * `UNAUTHENTICATED`, including a valid session of another tenant (host-only cookies make that
 * rare; this check makes it impossible).
 *
 * `@Public()` routes skip authentication. `@OperatorApi()` routes are authenticated by the
 * console's operator session instead. Routes without access metadata fail closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const access = routeAccessOf(context.getHandler(), context.getClass());
    if (access.length === 1 && (access[0]?.kind === 'public' || access[0]?.kind === 'operator')) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const tenant = req.tenant;
    if (req.hostKind !== 'tenant' || tenant === undefined) throw unauthenticated();

    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const principal = await this.sessions.authenticate(tenant.id, token);
    if (principal?.tenantId !== tenant.id) throw unauthenticated();

    req.actor = { kind: principal.kind, userId: principal.userId, sessionId: principal.sessionId };
    assignLogContext({ userId: principal.userId });
    return true;
  }
}
