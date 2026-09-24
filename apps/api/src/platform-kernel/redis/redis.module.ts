import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Shared Redis (Valkey) connection for caches, rate limits, presence and health. Nothing durable
 * lives in Redis (plan.md Complexity Tracking). BullMQ and the Socket.IO adapter open their own
 * connections from `REDIS_URL` because they need blocking or subscriber connections.
 */
export const REDIS = Symbol('REDIS');

const logger = new Logger('Redis');

export function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined || url === '') {
    throw new Error('REDIS_URL is not set');
  }
  return url;
}

/** Connects lazily, so creating the client does not need Redis to be up. */
export function createRedis(url: string, name: string): Redis {
  const client = new Redis(url, { lazyConnect: true, connectionName: `replyx-${name}`, maxRetriesPerRequest: 3 });
  client.on('error', (error: Error) => {
    logger.error(`Redis ${name} connection error: ${error.message}`);
  });
  return client;
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: () => createRedis(redisUrl(), 'main') }],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
