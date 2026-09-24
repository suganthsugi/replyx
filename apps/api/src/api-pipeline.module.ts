import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './identity/auth.guard.js';
import { IdentityModule } from './identity/identity.module.js';
import { HttpKernelModule } from './platform-kernel/http/http-kernel.module.js';
import { TenantStatusGuard } from './platform-kernel/http/tenant-resolver.middleware.js';

/**
 * The request pipeline of the `api` process, in constitution II order. The tenant resolver
 * middleware (HttpKernelModule) runs first; global guards then run in the order listed here,
 * which is why they are all registered in this one module.
 *
 *   resolve tenant (middleware) → tenant status → authenticate → [permission, T031] → handler
 */
@Module({
  imports: [HttpKernelModule, IdentityModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantStatusGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class ApiPipelineModule {}
