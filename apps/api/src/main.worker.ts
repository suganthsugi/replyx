import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoNestLogger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function bootstrap(): Promise<void> {
  // Application context only: no HTTP server, no WebSocket gateway.
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ role: 'worker' }), {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoNestLogger));
  await app.init();

  // Holds the process open until a shutdown signal. BullMQ consumers (T036) and the outbox
  // relay (T035) keep their own handles, but the worker must not exit when none are registered.
  const keepAlive = setInterval(() => undefined, 60_000);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    Logger.log(`Received ${signal}, shutting down`, 'Worker');
    clearInterval(keepAlive);
    await app.close();
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => void shutdown(signal));
  }

  Logger.log('Worker started', 'Worker');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'Worker');
  process.exit(1);
});
