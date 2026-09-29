import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { createDatabase, type Database } from '../../platform-kernel/db/database.js';
import { UnitOfWork } from '../../platform-kernel/db/unit-of-work.js';

import { AuditRetentionJob, RETENTION_UNIT_OF_WORK } from './audit-retention.job.js';
import { RetentionJob } from './retention.job.js';
import { RetentionService } from './retention.service.js';

import type { Kysely } from 'kysely';

const RETENTION_DB = Symbol('RETENTION_DB');

/**
 * `replyx_retention` pool (research D18): only the audit-log retention job uses it, to delete old
 * `audit_logs` rows the app role may not delete. `undefined` when `DATABASE_URL_RETENTION` is not
 * set (the job then reports that and does nothing).
 */
function retentionDatabase(): Kysely<Database> | undefined {
  const url = process.env.DATABASE_URL_RETENTION;
  return url === undefined || url === '' ? undefined : createDatabase(url, 'retention');
}

/** The purge logic, shared: the api counts what a shorter period would delete, the worker deletes. */
@Module({ providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}

/** Worker only: the two daily jobs (jobs.module.ts discovers them and routes the `retention` queue). */
@Module({
  imports: [RetentionModule],
  providers: [
    RetentionJob,
    AuditRetentionJob,
    { provide: RETENTION_DB, useFactory: retentionDatabase },
    {
      provide: RETENTION_UNIT_OF_WORK,
      useFactory: (db: Kysely<Database> | undefined) => (db === undefined ? undefined : new UnitOfWork(db)),
      inject: [RETENTION_DB],
    },
  ],
})
export class RetentionJobsModule implements OnApplicationShutdown {
  constructor(@Inject(RETENTION_DB) private readonly db: Kysely<Database> | undefined) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db?.destroy();
  }
}
