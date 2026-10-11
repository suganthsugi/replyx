import { Injectable } from '@nestjs/common';

import { tenantUrl } from '../../platform-kernel/http/public-url.js';
import { MailQueue } from '../../platform-kernel/mail/mail.service.js';

import type { ChannelMessage } from './channel-message.js';

/**
 * Email notifications to staff (research D20, the `notice` mail template). The digest job
 * (notification-digest.job.ts) has already grouped a burst into one message, so this sends one
 * email per digest. Recipients are always staff who can view the ticket (recipient-resolver.ts),
 * so an internal-note excerpt in a mention never reaches a customer.
 */

export interface EmailRecipient {
  email: string;
  tenantSlug: string;
  workspaceName: string;
}

@Injectable()
export class EmailChannel {
  constructor(private readonly mail: MailQueue) {}

  async send(tenantId: string, recipient: EmailRecipient, message: ChannelMessage, dedupeKey: string): Promise<void> {
    await this.mail.enqueue(
      {
        tenantId,
        to: recipient.email,
        template: 'notice',
        workspaceName: recipient.workspaceName,
        vars: {
          title: message.title,
          message: message.body ?? 'Open ReplyX to see the details.',
          actionLabel: 'Open in ReplyX',
          actionUrl: tenantUrl(recipient.tenantSlug, message.url),
        },
      },
      { dedupeKey },
    );
  }
}
