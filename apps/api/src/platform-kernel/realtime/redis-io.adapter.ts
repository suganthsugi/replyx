import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

import { createRedis, redisUrl } from '../redis/redis.module.js';

import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/** Socket.IO path (contracts/realtime-events.md "Connection"); Vite and Caddy proxy it. */
export const REALTIME_PATH = '/rt';

/**
 * Socket.IO on the api's HTTP server with the Redis adapter, so an emit from any api process (or
 * the worker's relay emitter) reaches sockets on every process (research D8).
 */
export class RedisIoAdapter extends IoAdapter {
  private pub?: Redis;
  private sub?: Redis;

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      path: REALTIME_PATH,
      serveClient: false,
      // Same-origin only: the web app is served from the tenant host.
      cors: undefined,
    }) as Server;
    this.pub ??= createRedis(redisUrl(), 'io-pub');
    this.sub ??= this.pub.duplicate({ connectionName: 'replyx-io-sub' });
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    this.pub?.disconnect();
    this.sub?.disconnect();
  }
}
