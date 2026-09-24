import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { configureApiApp } from './app.setup.js';

import type { NestExpressApplication } from '@nestjs/platform-express';

const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = configureApiApp(
    await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ role: 'api' }), { bufferLogs: true }),
  );

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exit(1);
});
