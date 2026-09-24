import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { configureApiApp } from '../../src/app.setup.js';
import { Clock } from '../../src/platform-kernel/clock.js';

import type { DynamicModule, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';

/**
 * The app under test (testing-conventions rules 3 and 9): the real `AppModule` in the api role,
 * configured by the same `configureApiApp` as main.api.ts, connected as `replyx_app`, listening
 * on an ephemeral port (for sockets), with `Clock` replaced by a `TestClock` tests can move.
 * One per test file (Vitest isolates files), closed after the file by support/env.ts.
 */

export class TestClock extends Clock {
  private ms = Date.now();

  now(): Date {
    return new Date(this.ms);
  }

  set(date: Date | string): void {
    this.ms = new Date(date).getTime();
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  advanceHours(hours: number): void {
    this.advance(hours * 3_600_000);
  }
}

export interface TestApp {
  app: NestExpressApplication;
  clock: TestClock;
  /** `http://127.0.0.1:{port}`, for socket.io-client. */
  baseUrl: string;
}

export interface TestWorker {
  module: TestingModule;
  clock: TestClock;
}

let apiApp: Promise<TestApp> | undefined;
let worker: Promise<TestWorker> | undefined;

/**
 * `options.imports` adds modules (e.g. a probe controller for kernel tests); only the first call
 * in a test file builds the app, so pass them there (typically in `beforeAll`).
 */
export function getTestApp(options: { imports?: (Type | DynamicModule)[] } = {}): Promise<TestApp> {
  apiApp ??= (async () => {
    const clock = new TestClock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot({ role: 'api' }), ...(options.imports ?? [])] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    const app = configureApiApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
    // Bootstrap syncs the permission registry, so provisioning can grant every key to Admin.
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return { app, clock, baseUrl: `http://127.0.0.1:${port}` };
  })();
  return apiApp;
}

/**
 * The worker process (outbox relay, consumers, processors) for tests that need events delivered.
 * Every test file that starts one competes for the relay lock; whichever leads publishes for all.
 */
export function getTestWorker(): Promise<TestWorker> {
  worker ??= (async () => {
    const clock = new TestClock();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot({ role: 'worker' })] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    await moduleRef.init();
    return { module: moduleRef, clock };
  })();
  return worker;
}

/** Resolves a provider from the api app (services, repositories' dependencies). */
export async function service<T>(token: abstract new (...args: never[]) => T): Promise<T> {
  return (await getTestApp()).app.get(token);
}

export async function closeTestApps(): Promise<void> {
  const [api, work] = [apiApp, worker];
  apiApp = undefined;
  worker = undefined;
  await Promise.all([api?.then(({ app }) => app.close()), work?.then(({ module }) => module.close())]);
}
