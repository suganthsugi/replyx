import { type DynamicModule, Module } from '@nestjs/common';

import { DatabaseModule } from './platform-kernel/db/database.js';
import { HttpKernelModule } from './platform-kernel/http/http-kernel.module.js';

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
    const shared: ModuleImports = [DatabaseModule];
    // HTTP controllers, guards and the Socket.IO gateway (api only).
    const apiOnly: ModuleImports = [HttpKernelModule];
    // Outbox relay, queue consumers and sweepers (worker only).
    const workerOnly: ModuleImports = [];

    return {
      module: AppModule,
      imports: [...shared, ...(options.role === 'api' ? apiOnly : workerOnly)],
    };
  }
}
