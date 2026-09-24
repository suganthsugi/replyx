import { type DynamicModule, Module } from '@nestjs/common';

import { ApiPipelineModule } from './api-pipeline.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { ClockModule } from './platform-kernel/clock.js';
import { DatabaseModule } from './platform-kernel/db/database.js';
import { JobsModule } from './platform-kernel/jobs/jobs.module.js';
import { HealthModule } from './platform-kernel/observability/health.controller.js';
import { LoggingModule } from './platform-kernel/observability/logger.js';
import { MetricsModule } from './platform-kernel/observability/metrics.js';
import { OutboxModule } from './platform-kernel/outbox/outbox.service.js';
import { OutboxRelayModule } from './platform-kernel/outbox/relay.js';
import { RealtimeModule } from './platform-kernel/realtime/gateway.js';
import { RedisModule } from './platform-kernel/redis/redis.module.js';
import { TenancyModule } from './tenancy/tenant-provisioning.service.js';

/**
 * The same codebase runs as two processes (research D1):
 * - `api`: HTTP + WebSocket (src/main.api.ts)
 * - `worker`: outbox relay, BullMQ consumers, sweepers; no HTTP (src/main.worker.ts)
 */
export type ProcessRole = 'api' | 'worker';

type ModuleImports = NonNullable<DynamicModule['imports']>;

@Module({})
export class AppModule {
  static forRoot(options: { role: ProcessRole }): DynamicModule {
    // Modules used by both processes (database, logging, outbox writer, domain modules).
    const shared: ModuleImports = [
      LoggingModule,
      MetricsModule,
      DatabaseModule,
      RedisModule,
      ClockModule,
      OutboxModule,
      // The api process syncs the permission registry on start-up; the worker only reads it.
      AuthorizationModule.forRoot({ syncOnBootstrap: options.role === 'api' }),
      TenancyModule,
    ];
    // HTTP controllers, guards and the Socket.IO gateway (api only).
    const apiOnly: ModuleImports = [ApiPipelineModule, HealthModule, RealtimeModule];
    // Outbox relay, queue consumers and sweepers (worker only).
    const workerOnly: ModuleImports = [JobsModule, OutboxRelayModule];

    return {
      module: AppModule,
      imports: [...shared, ...(options.role === 'api' ? apiOnly : workerOnly)],
    };
  }
}
