import { Module } from '@nestjs/common';

import { ChannelScheduler } from './channels/channel-scheduler.js';
import { EmailChannel } from './channels/email.channel.js';
import { NotificationDigestJob } from './channels/notification-digest.job.js';
import { PushChannel } from './channels/push.channel.js';
import { NotificationDefaultsContributor } from './notification-defaults.contributor.js';
import { NotificationsConsumer } from './notifications.consumer.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RecipientResolver } from './recipient-resolver.js';

/**
 * Notifications (research D20). The api process serves the notification center and seeds each
 * new tenant's defaults (tenants are provisioned there); the worker turns domain events into
 * notifications and sends push and email digests (jobs.module.ts discovers the consumer and the
 * digest job).
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDefaultsContributor],
})
export class NotificationsHttpModule {}

@Module({ providers: [RecipientResolver, NotificationsConsumer, ChannelScheduler, NotificationDigestJob, PushChannel, EmailChannel] })
export class NotificationsJobsModule {}
