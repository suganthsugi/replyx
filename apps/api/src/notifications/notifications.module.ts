import { Module } from '@nestjs/common';

import { NotificationDefaultsContributor } from './notification-defaults.contributor.js';
import { NotificationsConsumer } from './notifications.consumer.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RecipientResolver } from './recipient-resolver.js';

/**
 * Notifications (research D20). The api process serves the notification center and seeds each
 * new tenant's defaults (tenants are provisioned there); the worker turns domain events into
 * notifications (jobs.module.ts discovers the consumer).
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDefaultsContributor],
})
export class NotificationsHttpModule {}

@Module({ providers: [RecipientResolver, NotificationsConsumer] })
export class NotificationsJobsModule {}
