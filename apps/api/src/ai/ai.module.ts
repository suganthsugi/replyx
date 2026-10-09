import { Global, Module } from '@nestjs/common';

import { permissionsProvider } from '../authorization/registry/module-permissions.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { DirectNotifier } from '../notifications/direct-notifier.js';
import { SecretBox } from '../platform-kernel/crypto/secret-box.js';

import { AiAudience } from './ai-audience.js';
import { AiPermissions } from './ai.permissions.js';
import { AiTicketStatus } from './assistant/ai-ticket-status.js';
import { DRAFT_WRITER, PlaceholderDraftWriter } from './assistant/draft-writer.js';
import { HandoffWriter } from './assistant/handoff-writer.js';
import { ResponderService } from './assistant/responder.js';
import { PlaceholderTurnBrain, TURN_BRAIN } from './assistant/turn-brain.js';
import { commerceFromEnv } from './commerce/commerce-from-env.js';
import { COMMERCE_CONNECTOR } from './commerce/ports.js';
import { StoreConnectionController } from './commerce/store-connection.controller.js';
import { StoreConnectionService } from './commerce/store-connection.service.js';
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
    // T022 / T023 replace these two bindings; the turn job only knows the interfaces.
    { provide: TURN_BRAIN, useClass: PlaceholderTurnBrain },
    { provide: DRAFT_WRITER, useClass: PlaceholderDraftWriter },
  ],
  exports: [AI_PROVIDER, COMMERCE_CONNECTOR, SecretBox, AiRunsRecorder, AiAudience, AiStatus, PolicySearch, StoreConnectionService, AiTicketStatus, ResponderService, HandoffWriter, TURN_BRAIN, DRAFT_WRITER],
})
export class AiModule {}

/** AI HTTP routes (api process only). */
@Module({ controllers: [AiSettingsController, StoreConnectionController, AiPoliciesController, AiRunsController], providers: [AiSettingsService, AiPoliciesService, AiRunsService] })
export class AiHttpModule {}
