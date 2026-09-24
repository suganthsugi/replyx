import { pathToFileURL } from 'node:url';

import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { createRedis, REDIS, redisUrl } from './redis/redis.module.js';

/**
 * The only source of "now" for business logic (testing-conventions rule 9): session expiry,
 * lockout windows, grace periods, SLA and sweeper timers. Tests replace it with a fixed clock.
 *
 * Development only: `pnpm --filter api dev:advance-clock --hours 73` shifts every running dev
 * process (api, worker, sweeper) by storing an offset in Redis (quickstart.md main flow step 9).
 * Production never reads the offset, and the script refuses to run there.
 */
export abstract class Clock {
  abstract now(): Date;

  nowMs(): number {
    return this.now().getTime();
  }
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export const DEV_CLOCK_OFFSET_KEY = 'replyx:dev:clock-offset-ms';
const OFFSET_REFRESH_MS = 1_000;

/** System time plus the shared development offset, refreshed from Redis once a second. */
export class DevOffsetClock extends Clock implements OnApplicationShutdown {
  private offsetMs = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly logger = new Logger('DevOffsetClock');

  constructor(private readonly redis: Redis) {
    super();
    this.timer = setInterval(() => void this.refresh(), OFFSET_REFRESH_MS);
    this.timer.unref();
    void this.refresh();
  }

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  async refresh(): Promise<void> {
    try {
      const value = await this.redis.get(DEV_CLOCK_OFFSET_KEY);
      const next = value === null ? 0 : Number(value);
      if (Number.isFinite(next) && next !== this.offsetMs) {
        this.offsetMs = next;
        this.logger.warn(`Development clock offset is now ${(next / 3_600_000).toFixed(2)} h`);
      }
    } catch {
      // Redis unavailable: keep the last known offset.
    }
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

@Global()
@Module({
  providers: [
    {
      provide: Clock,
      useFactory: (redis: Redis) =>
        process.env.NODE_ENV === 'development' ? new DevOffsetClock(redis) : new SystemClock(),
      inject: [REDIS],
    },
  ],
  exports: [Clock],
})
export class ClockModule {}

// ---------------------------------------------------------------------------------------------
// dev:advance-clock
// ---------------------------------------------------------------------------------------------

export function parseAdvanceArgs(argv: readonly string[]): { hours: number } | { reset: true } {
  if (argv.includes('--reset')) return { reset: true };
  const index = argv.indexOf('--hours');
  const hours = index === -1 ? Number.NaN : Number(argv[index + 1]);
  if (!Number.isFinite(hours) || hours === 0) {
    throw new Error('Usage: dev:advance-clock --hours <n> | --reset');
  }
  return { hours };
}

async function advanceClock(argv: readonly string[]): Promise<string> {
  if (isProduction()) {
    throw new Error('dev:advance-clock is refused when NODE_ENV=production');
  }
  const args = parseAdvanceArgs(argv);
  const redis = createRedis(redisUrl(), 'advance-clock');
  try {
    if ('reset' in args) {
      await redis.del(DEV_CLOCK_OFFSET_KEY);
      return 'Development clock reset';
    }
    const total = await redis.incrby(DEV_CLOCK_OFFSET_KEY, Math.round(args.hours * 3_600_000));
    return `Development clock advanced by ${args.hours} h (total offset ${(total / 3_600_000).toFixed(2)} h)`;
  } finally {
    redis.disconnect();
  }
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const logger = new Logger('AdvanceClock');
  advanceClock(process.argv.slice(2)).then(
    (message) => logger.log(message),
    (error: unknown) => {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
