import { constants as fsConstants, promises as fs } from 'node:fs';

import { Controller, Get, HttpCode, Inject, Module, Res } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';

import { Public } from '../../authorization/registry/module-permissions.js';
import { PLATFORM_DB, type Database } from '../db/database.js';
import { REDIS } from '../redis/redis.module.js';

import type { Response } from 'express';
import type { Redis } from 'ioredis';

type CheckResult = 'ok' | 'failed';

const CHECK_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness for Docker healthchecks (research D22). Served outside the `/api/v1`
 * prefix and outside tenant resolution. Responses name the failing dependency but never include
 * error messages or connection details.
 */
@Controller('health')
@Public()
export class HealthController {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis, storage] = await Promise.all([
      check(() => sql`SELECT 1`.execute(this.db)),
      check(() => this.redis.ping()),
      check(() => fs.access(filesDir(), fsConstants.W_OK)),
    ]);
    const checks = { database, redis, storage };
    const ok = Object.values(checks).every((result) => result === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }
}

function filesDir(): string {
  return process.env.FILES_DIR ?? '/data/files';
}

async function check(probe: () => Promise<unknown>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'ok';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
