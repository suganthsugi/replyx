import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';

import { AppModule } from './app.module.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

// contracts/common.yaml: servers -> https://{tenant}.replyx.app/api/v1
const API_PREFIX = 'api/v1';
const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ role: 'api' }));

  app.disable('x-powered-by');
  app.setGlobalPrefix(API_PREFIX);
  // Socket.IO on the same HTTP server. The gateway (T037) sets path `/rt` and swaps in the
  // Redis adapter for cross-process fan-out.
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exit(1);
});
