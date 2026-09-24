import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ErrorFilter } from './error.filter.js';
import { RateLimiter } from './rate-limit.js';
import { TenantResolver, TenantResolverMiddleware } from './tenant-resolver.middleware.js';

/**
 * HTTP plumbing for the `api` process: the error filter, the tenant resolver middleware and the
 * rate limiter.
 * Registered as app providers (not in main.api.ts) so tests that build the app from `AppModule`
 * get the same pipeline. Global guards are registered, in order, by `ApiPipelineModule`.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }, TenantResolver, RateLimiter],
  exports: [TenantResolver, RateLimiter],
})
export class HttpKernelModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolverMiddleware).forRoutes({ path: '{*rest}', method: RequestMethod.ALL });
  }
}
