import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { routeAccessOf } from '../authorization/registry/module-permissions.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { unauthenticated } from '../platform-kernel/http/app-error.js';
import { requestIdOf } from '../platform-kernel/http/request-context.js';
import { assignLogContext } from '../platform-kernel/observability/logger.js';

import {
  decodeSupportToken,
  readOnlySupportAccess,
  SUPPORT_TOKEN_HEADER,
  SupportAccessService,
} from './support-access.service.js';

import type { Request } from 'express';

/**
 * Accepts a platform operator's support token on a tenant host (FR-001a, T079). It runs right
 * after the tenant `AuthGuard`, so a request carrying both a session and a support token is
 * handled as the session's user — a token never widens someone else's access.
 *
 * What a support session may do:
 * - **read only**: any method other than GET or HEAD is 403 `READ_ONLY_SUPPORT_ACCESS`, and the
 *   context it builds is read-only at the database too, so a handler cannot write by mistake;
 * - **nothing after the grant ends**: the grant is re-read on every request, so revoking it
 *   takes effect on the next call, not at the token's expiry;
 * - **nothing unaudited**: each accepted request writes one `support_access.read` entry with the
 *   method and path, never any content.
 *
 * A token that is malformed, signed for another tenant, expired or revoked is 401
 * `UNAUTHENTICATED`, the same answer as any other unusable credential.
 */
@Injectable()
export class SupportAccessGuard implements CanActivate {
  constructor(private readonly supportAccess: SupportAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();

    const header = req.headers[SUPPORT_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (token === undefined || token === '') return true;

    // A public route needs no credential; an operator route lives on the console host.
    const access = routeAccessOf(context.getHandler(), context.getClass());
    if (access.length === 1 && (access[0]?.kind === 'public' || access[0]?.kind === 'operator')) return true;

    const tenant = req.tenant;
    if (req.hostKind !== 'tenant' || tenant === undefined) throw unauthenticated();
    // A signed-in user's own session wins; the token is ignored rather than combined with it.
    if (req.actor !== undefined) return true;

    const claims = decodeSupportToken(token);
    if (claims === undefined || claims.tenantId !== tenant.id || claims.expiresAt <= Date.now()) {
      throw unauthenticated();
    }

    const ctx = supportContext(tenant.id, claims.operatorId, req);
    if (!(await this.supportAccess.grantIsActive(ctx, claims.grantId))) throw unauthenticated();

    if (req.method !== 'GET' && req.method !== 'HEAD') throw readOnlySupportAccess();

    req.support = { operatorId: claims.operatorId, grantId: claims.grantId };
    assignLogContext({ userId: claims.operatorId });
    await this.supportAccess.recordRead(
      // The audit entry is a write, so it needs a context that is not pinned read-only.
      TenantContext.create({
        tenantId: tenant.id,
        actor: { kind: 'operator', id: claims.operatorId },
        requestId: requestIdOf(req),
        ip: req.ip ?? null,
      }),
      { method: req.method, path: req.path.slice(0, 200), grantId: claims.grantId },
    );
    return true;
  }
}

/** The read-only context a support request runs under; `tenantContextOf` builds the same one. */
export function supportContext(tenantId: string, operatorId: string, req: Request): TenantContext {
  return TenantContext.create({
    tenantId,
    actor: { kind: 'operator', id: operatorId },
    requestId: requestIdOf(req),
    ip: req.ip ?? null,
    readOnly: true,
  });
}
