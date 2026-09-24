import { TenantContext } from '../db/tenant-context.js';

import type { Request } from 'express';

/**
 * What the HTTP pipeline attaches to each request, in pipeline order (constitution II, C1):
 * tenant from the host (tenant-resolver.middleware.ts) → session and actor (identity/auth.guard.ts)
 * → permission (authorization/permission.guard.ts).
 */

export interface ResolvedTenant {
  readonly id: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
}

/** `tenant`: `{slug}.{BASE_DOMAIN}`; `console`: `CONSOLE_HOST` (platform operators). */
export type HostKind = 'tenant' | 'console';

/** The authenticated caller, set by the auth guard. */
export interface RequestActor {
  readonly kind: 'staff' | 'customer';
  readonly userId: string;
  readonly sessionId: string;
}

/** A platform operator on the console host, set by the operator auth guard (T081). */
export interface RequestOperator {
  readonly operatorId: string;
  readonly sessionId: string;
}

// @types/express merges the global Express.Request into its Request type.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the only augmentation point
  namespace Express {
    interface Request {
      hostKind?: HostKind;
      /** Set for every request on a tenant host; never on the console host. */
      tenant?: ResolvedTenant;
      actor?: RequestActor;
      operator?: RequestOperator;
    }
  }
}

/**
 * The unit-of-work context for an authenticated tenant request: tenant from the host, actor from
 * the session, request id from the request logger. Throws (programming error) when called on a
 * route that is not tenant-authenticated.
 */
export function tenantContextOf(req: Request): TenantContext {
  if (req.tenant === undefined || req.actor === undefined) {
    throw new Error('tenantContextOf needs a resolved tenant and an authenticated actor');
  }
  return TenantContext.create({
    tenantId: req.tenant.id,
    actor: { kind: 'user', id: req.actor.userId },
    requestId: requestIdOf(req),
    ip: req.ip ?? null,
  });
}

/** pino-http's request id (`X-Request-Id`), always set by the logger middleware. */
export function requestIdOf(req: Request): string {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : 'unknown';
}
