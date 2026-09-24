import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ErrorFilter } from './error.filter.js';

/**
 * HTTP plumbing for the `api` process: the global error filter now; tenant resolution, CSRF and
 * rate limiting join it as they are added. Registered as app providers (not in main.api.ts) so
 * tests that build the app from `AppModule` get the same pipeline.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class HttpKernelModule {}
