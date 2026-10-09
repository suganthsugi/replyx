import { Global, Module } from '@nestjs/common';

import { permissionsProvider } from '../authorization/registry/module-permissions.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { DirectNotifier } from '../notifications/direct-notifier.js';
import { SecretBox } from '../platform-kernel/crypto/secret-box.js';
import { PresenceService } from '../platform-kernel/realtime/presence.service.js';
import { TicketsHttpModule } from '../tickets/tickets.module.js';

import { AiAudience } from './ai-audience.js';
import { AiPermissions } from './ai.permissions.js';
import { AiTakeoverController } from './assistant/ai-takeover.controller.js';
import { AiTakeoverService } from './assistant/ai-takeover.service.js';
import { AiTicketStatus } from './assistant/ai-ticket-status.js';
import { AssistantBrain } from './assistant/assistant-brain.js';
import { AssistantTools } from './assistant/assistant-tools.js';
import { AssistantTyping } from './assistant/assistant-typing.js';
import { DRAFT_WRITER } from './assistant/draft-writer.js';
import { HandoffScreen } from './assistant/handoff-screen.js';
import { HandoffWriter } from './assistant/handoff-writer.js';
import { ResponderService } from './assistant/responder.js';
import { TURN_BRAIN } from './assistant/turn-brain.js';
import { commerceFromEnv } from './commerce/commerce-from-env.js';
import { COMMERCE_CONNECTOR } from './commerce/ports.js';
import { StoreConnectionController } from './commerce/store-connection.controller.js';
import { StoreConnectionService } from './commerce/store-connection.service.js';
import { AiDraftWriter } from './drafts/ai-draft-writer.js';
import { AiDraftsController } from './drafts/ai-drafts.controller.js';
import { AiDraftsService } from './drafts/ai-drafts.service.js';
import { AiPoliciesController } from './knowledge/ai-policies.controller.js';
import { AiPoliciesService } from './knowledge/ai-policies.service.js';
import { PolicySearch } from './knowledge/policy-search.js';
import { AI_PROVIDER } from './providers/ports.js';
import { providerFromEnv } from './providers/provider-from-env.js';
import { AiRunsController } from './runs/ai-runs.controller.js';
import { AiRunsRecorder } from './runs/ai-runs.recorder.js';
import { AiRunsService } from './runs/ai-runs.service.js';
import { AiSettingsController } from './settings/ai-settings.controller.js';
import { AiSettingsService } from './settings/ai-settings.service.js';
import { AiStatus } from './settings/ai-status.js';

/**
 * AI Assist (specs/002-ai-assist), shared by the api and worker processes: the permissions, the
 * provider chosen by `AI_PROVIDER`, the store connector chosen by `COMMERCE_PROVIDER` and the tenant's
 * store connection, the secret box for tenant keys, the run recorder, AI status and pausing, the
 * admin event audience, and the assistant's shared pieces: whether it is handling a ticket, the
 * responder, the hand-off writer and the bindings for the turn brain and the draft writer. Global
 * because messaging, notifications, routing and SLA ask it about the assistant. HTTP controllers are
 * in `AiHttpModule`; queue consumers and jobs are in `AiJobsModule`.
 */
@Global()
@Module({
  imports: [MessagingModule],
  providers: [
    permissionsProvider(AiPermissions),
    { provide: AI_PROVIDER, useFactory: () => providerFromEnv() },
    { provide: COMMERCE_CONNECTOR, useFactory: () => commerceFromEnv() },
    { provide: SecretBox, useFactory: () => new SecretBox() },
    AiRunsRecorder,
    AiAudience,
    AiStatus,
    PolicySearch,
    StoreConnectionService,
    DirectNotifier,
    AiTicketStatus,
    ResponderService,
    HandoffWriter,
    HandoffScreen,
    AssistantTools,
    AssistantTyping,
    PresenceService,
    AssistantBrain,
    // The turn job only knows these two interfaces; T023 replaces the draft writer.
    { provide: TURN_BRAIN, useExisting: AssistantBrain },
    { provide: DRAFT_WRITER, useClass: AiDraftWriter },
  ],
  exports: [AI_PROVIDER, COMMERCE_CONNECTOR, SecretBox, AiRunsRecorder, AiAudience, AiStatus, PolicySearch, StoreConnectionService, AiTicketStatus, ResponderService, HandoffWriter, TURN_BRAIN, DRAFT_WRITER],
})
export class AiModule {}

/** AI HTTP routes (api process only). */
@Module({
  imports: [TicketsHttpModule],
  controllers: [AiSettingsController, StoreConnectionController, AiPoliciesController, AiRunsController, AiDraftsController, AiTakeoverController],
  providers: [AiSettingsService, AiPoliciesService, AiRunsService, AiDraftsService, AiTakeoverService],
})
export class AiHttpModule {}
