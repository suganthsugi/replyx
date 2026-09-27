import { type DynamicModule, Module } from '@nestjs/common';

import { ApiPipelineModule } from './api-pipeline.module.js';
import { AttachmentsHttpModule, FileStorageModule } from './attachments/attachments.module.js';
import { AttachmentJobsModule } from './attachments/scan.job.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { RolesHttpModule } from './authorization/roles.controller.js';
import { CustomersHttpModule } from './customers/customers.module.js';
import { GroupsHttpModule } from './groups/groups.controller.js';
import { IdentityJobsModule } from './identity/erasure.job.js';
import { MessagingHttpModule, MessagingModule } from './messaging/messaging.module.js';
import { MessagingJobsModule } from './messaging/offline-reply-email.consumer.js';
import { NotificationsHttpModule, NotificationsJobsModule } from './notifications/notifications.module.js';
import { ClockModule } from './platform-kernel/clock.js';
import { DatabaseModule } from './platform-kernel/db/database.js';
import { JobsModule } from './platform-kernel/jobs/jobs.module.js';
import { QueuesModule } from './platform-kernel/jobs/queues.js';
import { MailModule } from './platform-kernel/mail/mail.service.js';
import { HealthModule } from './platform-kernel/observability/health.controller.js';
import { LoggingModule } from './platform-kernel/observability/logger.js';
import { MetricsModule } from './platform-kernel/observability/metrics.js';
import { OutboxModule } from './platform-kernel/outbox/outbox.service.js';
import { OutboxRelayModule } from './platform-kernel/outbox/relay.js';
import { RealtimeModule } from './platform-kernel/realtime/gateway.js';
import { RedisModule } from './platform-kernel/redis/redis.module.js';
import { TagsHttpModule, TagsModule } from './tags/tags.module.js';
import { TenancyHttpModule } from './tenancy/tenancy-http.module.js';
import { TenancyModule } from './tenancy/tenant-provisioning.service.js';
import { TicketsJobsModule } from './tickets/access-loss.consumer.js';
import { TicketSweeperModule } from './tickets/sweeper.job.js';
import { TicketsHttpModule, TicketsModule } from './tickets/tickets.module.js';
import { ViewsJobsModule } from './views/counts-notifier.js';
import { ViewsModule } from './views/views.module.js';

/**
 * The same codebase runs as two processes (research D1):
 * - `api`: HTTP + WebSocket (src/main.api.ts)
 * - `worker`: outbox relay, BullMQ consumers, sweepers; no HTTP (src/main.worker.ts)
 */
export type ProcessRole = 'api' | 'worker';

type ModuleImports = NonNullable<DynamicModule['imports']>;

@Module({})
export class AppModule {
  static forRoot(options: { role: ProcessRole }): DynamicModule {
    // Modules used by both processes (database, logging, outbox writer, domain modules).
    const shared: ModuleImports = [
      LoggingModule,
      MetricsModule,
      DatabaseModule,
      RedisModule,
      ClockModule,
      OutboxModule,
      QueuesModule,
      MailModule,
      // The api process syncs the permission registry on start-up; the worker only reads it.
      AuthorizationModule.forRoot({ syncOnBootstrap: options.role === 'api' }),
      TenancyModule,
      AuditModule,
      TagsModule,
      TicketsModule,
      MessagingModule,
      FileStorageModule,
    ];
    // HTTP controllers, guards and the Socket.IO gateway (api only).
    const apiOnly: ModuleImports = [
      ApiPipelineModule,
      HealthModule,
      RealtimeModule,
      RolesHttpModule,
      GroupsHttpModule,
      TenancyHttpModule,
      MessagingHttpModule,
      AttachmentsHttpModule,
      TicketsHttpModule,
      TagsHttpModule,
      CustomersHttpModule,
      ViewsModule,
      NotificationsHttpModule,
    ];
    // Outbox relay, queue consumers and sweepers (worker only).
    const workerOnly: ModuleImports = [
      JobsModule,
      OutboxRelayModule,
      IdentityJobsModule,
      MessagingJobsModule,
      AttachmentJobsModule,
      TicketsJobsModule,
      TicketSweeperModule,
      ViewsJobsModule,
      NotificationsJobsModule,
    ];

    return {
      module: AppModule,
      imports: [...shared, ...(options.role === 'api' ? apiOnly : workerOnly)],
    };
  }
}
