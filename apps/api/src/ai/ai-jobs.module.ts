import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module.js';

import { AiTurnJob } from './assistant/ai-turn.job.js';
import { ConversationSummary } from './assistant/conversation-summary.js';
import { AiTriggerConsumer, StaffReplyConsumer } from './consumers.js';
import { AiIndexJob, AiPolicyIndexEnqueuer } from './knowledge/policy-index.job.js';

/**
 * AI queue consumers and jobs (worker process only): policy indexing (US2) and the assistant's
 * trigger consumers and turn job (US3). The turn's brain and draft writer are bound in `AiModule`.
 */
@Module({
  imports: [MessagingModule],
  providers: [AiPolicyIndexEnqueuer, AiIndexJob, AiTriggerConsumer, StaffReplyConsumer, ConversationSummary, AiTurnJob],
})
export class AiJobsModule {}
