import {
  Global,
  Injectable,
  Logger,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

import type { Gauge, Histogram, UpDownCounter } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

/**
 * OpenTelemetry metrics with a Prometheus exporter (research D22). Each process (api, worker)
 * serves `/metrics` on its own `METRICS_PORT` (default 9464) on the internal network only; Caddy
 * never proxies it. `METRICS_PORT=0` (the default under tests) turns the listener off.
 */
export function metricsPort(): number {
  const raw = process.env.METRICS_PORT ?? (process.env.NODE_ENV === 'test' ? '0' : '9464');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('METRICS_PORT must be a port number');
  }
  return port;
}

const logger = new Logger('Metrics');

@Injectable()
export class MetricsService implements OnApplicationShutdown {
  readonly exporter: PrometheusExporter;
  private readonly provider: MeterProvider;

  readonly httpDuration: Histogram;
  readonly wsConnections: UpDownCounter;
  readonly outboxRelayLag: Gauge;
  readonly queueDepth: Gauge;
  readonly deadLetterCount: Gauge;
  readonly realtimeDeliveryLag: Histogram;
  readonly sweeperLag: Gauge;

  constructor() {
    const port = metricsPort();
    this.exporter = new PrometheusExporter({ port: port === 0 ? undefined : port, preventServerStart: port === 0 }, (error) => {
      if (error !== undefined && error !== null) {
        logger.error(`Metrics listener failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    });
    this.provider = new MeterProvider({ readers: [this.exporter] });
    const meter = this.provider.getMeter('replyx');

    this.httpDuration = meter.createHistogram('http_server_request_duration_seconds', {
      description: 'HTTP request latency',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5] },
    });
    this.wsConnections = meter.createUpDownCounter('ws_connections', {
      description: 'Open Socket.IO connections',
    });
    this.outboxRelayLag = meter.createGauge('outbox_relay_lag_seconds', {
      description: 'Age of the oldest unpublished outbox event',
      unit: 's',
    });
    this.queueDepth = meter.createGauge('queue_depth', { description: 'Waiting jobs per queue' });
    this.deadLetterCount = meter.createGauge('dead_letter_count', {
      description: 'Jobs in the dead-letter queue',
    });
    this.realtimeDeliveryLag = meter.createHistogram('realtime_delivery_lag_seconds', {
      description: 'Time from outbox commit to socket emit',
      unit: 's',
      advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] },
    });
    this.sweeperLag = meter.createGauge('sweeper_lag_seconds', {
      description: 'How late the most overdue timer was when the sweeper processed it',
      unit: 's',
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

/**
 * Records request latency per route template (never the raw URL, to keep label cardinality
 * bounded and ids out of metrics).
 */
function httpMetricsMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const route = (req.route as { path?: unknown } | undefined)?.path;
      metrics.httpDuration.record(Number(process.hrtime.bigint() - started) / 1e9, {
        method: req.method,
        route: typeof route === 'string' ? `${req.baseUrl}${route}` : 'unmatched',
        status: res.statusCode,
      });
    });
    next();
  };
}

@Global()
@Module({ providers: [MetricsService], exports: [MetricsService] })
export class MetricsModule implements NestModule {
  constructor(private readonly metrics: MetricsService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(httpMetricsMiddleware(this.metrics)).forRoutes('*');
  }
}
