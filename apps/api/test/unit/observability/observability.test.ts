import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { HealthController } from '../../../src/platform-kernel/observability/health.controller.js';
import { REDACT_PATHS, requestIdFrom } from '../../../src/platform-kernel/observability/logger.js';
import { MetricsService, metricsPort } from '../../../src/platform-kernel/observability/metrics.js';

import type { Response } from 'express';

describe('requestIdFrom', () => {
  it('keeps a well-formed incoming id', () => {
    expect(requestIdFrom('caddy-abc.123')).toBe('caddy-abc.123');
    expect(requestIdFrom(['first', 'second'])).toBe('first');
  });

  it('replaces missing or malformed ids with a UUID', () => {
    for (const header of [undefined, '', 'has spaces', 'x'.repeat(129), 'inject\n{"level":60}']) {
      expect(requestIdFrom(header)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('log redaction', () => {
  it('never writes secrets or message bodies', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      password: 'hunter2',
      token: 'tok-1',
      body: { body: 'message text', title: 'kept' },
      input: { token: 'tok-2', newPassword: 'n', currentPassword: 'c', secret: 's' },
      message: { body: 'note text' },
      req: { headers: { cookie: 'rx_session=abc', authorization: 'Bearer x', 'x-csrf-token': 'csrf' } },
    });
    const output = lines.join('');
    for (const leaked of ['hunter2', 'tok-1', 'tok-2', 'message text', 'note text', 'rx_session', 'Bearer', 'csrf"', '"n"', '"c"', '"s"']) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain('kept');
  });
});

describe('HealthController', () => {
  function response() {
    return { statusCode: 0, status(code: number) { this.statusCode = code; return this; } };
  }
  const okDb = { getExecutor: () => ({}) };

  it('reports live without dependencies', () => {
    expect(new HealthController(okDb as never, {} as never).live()).toEqual({ status: 'ok' });
  });

  it('answers 503 and names the failing dependency', async () => {
    process.env.FILES_DIR = '/definitely/missing/dir';
    const failingDb = {
      getExecutor: () => {
        throw new Error('connection refused to postgres://secret@db');
      },
    };
    const redis = { ping: () => Promise.resolve('PONG') };
    const res = response();
    const result = await new HealthController(failingDb as never, redis as never).ready(res as unknown as Response);
    expect(res.statusCode).toBe(503);
    expect(result).toEqual({ status: 'unavailable', checks: { database: 'failed', redis: 'ok', storage: 'failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('MetricsService', () => {
  it('does not listen under tests and exposes the named instruments', async () => {
    expect(metricsPort()).toBe(0);
    const metrics = new MetricsService();
    metrics.wsConnections.add(1);
    metrics.outboxRelayLag.record(0.4);
    metrics.httpDuration.record(0.02, { method: 'GET', route: '/api/v1/x', status: 200 });
    const { resourceMetrics } = await metrics.exporter.collect();
    const names = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics.map((m) => m.descriptor.name));
    expect(names).toEqual(expect.arrayContaining(['ws_connections', 'outbox_relay_lag_seconds', 'http_server_request_duration_seconds']));
    await metrics.onApplicationShutdown();
  });

  it('rejects an invalid METRICS_PORT', () => {
    process.env.METRICS_PORT = 'abc';
    try {
      expect(() => metricsPort()).toThrow('METRICS_PORT');
    } finally {
      delete process.env.METRICS_PORT;
    }
  });
});
