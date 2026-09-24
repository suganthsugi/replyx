import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import { AppError, permissionDenied, unauthenticated } from '../platform-kernel/http/app-error.js';
import { tenantContextOf } from '../platform-kernel/http/request-context.js';

import { PolicyService } from './policy.service.js';
import { routeAccessOf } from './registry/module-permissions.js';

import type { Request } from 'express';

/**
 * Identical to the error filter's answer for an unknown route: the other audience's API does not
 * exist for the caller.
 */
export function routeNotFound(): AppError {
  return new AppError('NOT_FOUND', 404, 'Not found');
}

/**
 * Last guard of the pipeline (constitution II): enforces the route's single access decorator.
 *
 * - `@RequirePermission(key)`: staff only; the policy service decides, `deny` → 403. Resource
 *   visibility (tickets outside the user's groups → 404) is decided by the service handling
 *   the resource, through the same policy service.
 * - `@CustomerApi()`: customer sessions only.
 * - A customer on a staff route or staff on a customer route gets 404, not 403 (research D9):
 *   the other surface does not exist for them.
 * - `@OperatorApi()`: console host with an operator session (set by the operator auth guard, T081).
 * - `@Public()`: nothing to check.
 *
 * A route without exactly one decorator never gets here in a running app (route-audit.ts fails
 * start-up); if one does, it is refused.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly policy: PolicyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const access = routeAccessOf(context.getHandler(), context.getClass());
    const entry = access.length === 1 ? access[0] : undefined;

    switch (entry?.kind) {
      case 'public':
        return true;
      case 'operator':
        if (req.hostKind !== 'console') throw routeNotFound();
        if (req.operator === undefined) throw unauthenticated();
        return true;
      case 'customer':
        if (req.actor?.kind !== 'customer') throw routeNotFound();
        return true;
      case 'permission': {
        if (req.actor?.kind !== 'staff') throw routeNotFound();
        const decision = await this.policy.can(tenantContextOf(req), entry.permission);
        if (decision === 'allow') return true;
        throw decision === 'not_found' ? routeNotFound() : permissionDenied();
      }
      case undefined:
        throw new Error('Route has no single access decorator');
    }
  }
}
