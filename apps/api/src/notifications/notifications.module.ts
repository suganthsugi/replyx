import { Module } from '@nestjs/common';

import { NotificationDefaultsContributor } from './notification-defaults.contributor.js';
import { NotificationsConsumer } from './notifications.consumer.js';
import { RecipientResolver } from './recipient-resolver.js';

/**
 * Notifications (research D20). The api process seeds each new tenant's defaults (tenants are
 * provisioned there); the worker turns domain events into notifications (jobs.module.ts discovers
 * the consumer).
 */
@Module({ providers: [NotificationDefaultsContributor] })
export class NotificationsHttpModule {}

@Module({ providers: [RecipientResolver, NotificationsConsumer] })
export class NotificationsJobsModule {}
