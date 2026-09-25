import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { routeAccessOf } from '../../authorization/registry/module-permissions.js';
import { parseCookies } from '../../platform-kernel/http/cookies.js';
import { assignLogContext } from '../../platform-kernel/observability/logger.js';

import { OPERATOR_SESSION_COOKIE, OperatorSessionService } from './operator-session.service.js';

import type { Request } from 'express';

/**
 * Authentication for `@OperatorApi()` routes, beside the tenant `AuthGuard` in the pipeline
 * (constitution II): reads `rx_op_session` on the console host and sets `req.operator`.
 *
 * It never rejects on its own — the permission guard decides, so an operator route on a tenant
 * host is a 404 (the API does not exist there) and a console route without a session is a 401.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(private readonly sessions: OperatorSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const access = routeAccessOf(context.getHandler(), context.getClass());
    if (access.length !== 1 || access[0]?.kind !== 'operator') return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (req.hostKind !== 'console') return true;

    const token = parseCookies(req.headers.cookie).get(OPERATOR_SESSION_COOKIE);
    const principal = await this.sessions.authenticate(token);
    if (principal === undefined) return true;

    req.operator = { operatorId: principal.operatorId, sessionId: principal.sessionId };
    assignLogContext({ userId: principal.operatorId });
    return true;
  }
}
