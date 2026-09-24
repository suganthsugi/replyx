import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { ErrorFilter } from './error.filter.js';
import { TenantResolver, TenantResolverMiddleware, TenantStatusGuard } from './tenant-resolver.middleware.js';

/**
 * HTTP plumbing for the `api` process. Registered as app providers (not in main.api.ts) so tests
 * that build the app from `AppModule` get the same pipeline. Order (constitution II, C1):
 * resolve tenant (middleware) → tenant status → authenticate → permission (guards, in the order
 * their modules register them).
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    TenantResolver,
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
  exports: [TenantResolver],
})
export class HttpKernelModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolverMiddleware).forRoutes({ path: '{*rest}', method: RequestMethod.ALL });
  }
}
