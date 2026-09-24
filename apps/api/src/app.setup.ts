import { Logger } from 'nestjs-pino';

import { RedisIoAdapter } from './platform-kernel/realtime/redis-io.adapter.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

// contracts/common.yaml: servers -> https://{tenant}.replyx.app/api/v1
export const API_PREFIX = 'api/v1';

/** Docker healthchecks call these on the container directly: no prefix, no tenant host. */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];

/**
 * Everything the `api` process configures on the Nest app besides its modules. main.api.ts and
 * the integration-test harness both call this, so tests run the production HTTP pipeline.
 */
export function configureApiApp(app: NestExpressApplication): NestExpressApplication {
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  // Host-based tenant resolution needs the original Host; Caddy is the only proxy in front.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  // Socket.IO on the same HTTP server at `/rt`, with the Redis adapter for cross-process fan-out.
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  app.enableShutdownHooks();
  return app;
}
