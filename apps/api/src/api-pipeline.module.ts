import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { PermissionGuard } from './authorization/permission.guard.js';
import { AuthGuard } from './identity/auth.guard.js';
import { IdentityModule } from './identity/identity.module.js';
import { CsrfGuard } from './platform-kernel/http/csrf.guard.js';
import { HttpKernelModule } from './platform-kernel/http/http-kernel.module.js';
import { RateLimitGuard } from './platform-kernel/http/rate-limit.js';
import { TenantStatusGuard } from './platform-kernel/http/tenant-resolver.middleware.js';

/**
 * The request pipeline of the `api` process, in constitution II order. The tenant resolver
 * middleware (HttpKernelModule) runs first; global guards then run in the order listed here,
 * which is why they are all registered in this one module.
 *
 *   resolve tenant (middleware) → tenant status → CSRF → authenticate → rate limit → permission
 *   → handler
 *
 * CSRF runs before authentication: it needs no database work, so forged requests stop early.
 */
@Module({
  imports: [HttpKernelModule, IdentityModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantStatusGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class ApiPipelineModule {}
