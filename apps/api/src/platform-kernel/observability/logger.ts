import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import { storage, Store } from 'nestjs-pino/storage.js';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger as PinoRoot } from 'pino';

/**
 * Structured JSON logs (research D22, constitution X). Every line carries `requestId` for HTTP
 * requests; `tenantId`, `userId`, `jobId` and `eventId` are added with `assignLogContext` /
 * `runWithLogContext` once they are known. Request logs contain method, path and status only:
 * no headers, no bodies, no query strings (sign-in links carry tokens in the query).
 */

/** Fields that must never reach a log line, wherever they appear (pino redact paths). */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  '*.token',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  'cookie',
  '*.cookie',
  'authorization',
  '*.authorization',
  'body.body',
  'message.body',
  '*.message.body',
  'secret',
  '*.secret',
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export interface LogContext {
  tenantId?: string;
  userId?: string;
  jobId?: string;
  eventId?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses a well-formed incoming `X-Request-Id` (from Caddy or a client), otherwise a new UUID. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export function logLevel(): string {
  return process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
}

/** Adds fields to every later log line of the current request or job. No-op outside one. */
export function assignLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store !== undefined) {
    store.logger = store.logger.child(fields);
  }
}

/** Runs `fn` with its own log context (jobs, relay batches, socket handlers). */
export function runWithLogContext<T>(fields: LogContext, fn: () => T): T {
  // `root` is typed as always set, but it is undefined until LoggingModule has initialised.
  const root: PinoRoot | undefined = PinoLogger.root;
  const parent = storage.getStore()?.logger ?? root;
  if (parent === undefined) {
    return fn();
  }
  return storage.run(new Store(parent.child(fields)), fn);
}

function pathOnly(url: string | undefined): string | undefined {
  return url?.split('?', 1)[0];
}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: logLevel(),
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const id = requestIdFrom(req.headers['x-request-id']);
          res.setHeader('X-Request-Id', id);
          return id;
        },
        customAttributeKeys: { reqId: 'requestId' },
        quietReqLogger: true,
        autoLogging: { ignore: (req: IncomingMessage) => pathOnly(req.url)?.startsWith('/health/') ?? false },
        serializers: {
          req: (req: { method?: string; url?: string }) => ({ method: req.method, url: pathOnly(req.url) }),
          res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        },
      },
    }),
  ],
})
export class LoggingModule {}
