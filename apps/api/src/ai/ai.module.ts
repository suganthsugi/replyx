import { Global, Module } from '@nestjs/common';

import { permissionsProvider } from '../authorization/registry/module-permissions.js';
import { DirectNotifier } from '../notifications/direct-notifier.js';
import { SecretBox } from '../platform-kernel/crypto/secret-box.js';

import { AiAudience } from './ai-audience.js';
import { AiPermissions } from './ai.permissions.js';
import { AiPoliciesController } from './knowledge/ai-policies.controller.js';
import { AiPoliciesService } from './knowledge/ai-policies.service.js';
import { AI_PROVIDER } from './providers/ports.js';
import { providerFromEnv } from './providers/provider-from-env.js';
import { AiRunsRecorder } from './runs/ai-runs.recorder.js';
import { AiSettingsController } from './settings/ai-settings.controller.js';
import { AiSettingsService } from './settings/ai-settings.service.js';
import { AiStatus } from './settings/ai-status.js';

/**
 * AI Assist (specs/002-ai-assist), shared by the api and worker processes: the permissions, the
 * provider chosen by `AI_PROVIDER`, the secret box for tenant keys, the run recorder, AI status and
 * pausing, and the admin event audience. Global because messaging, routing and SLA ask it about
 * the assistant. HTTP controllers are in `AiHttpModule`; queue consumers are added by the story
 * modules.
 */
@Global()
@Module({
  providers: [
    permissionsProvider(AiPermissions),
    { provide: AI_PROVIDER, useFactory: () => providerFromEnv() },
    { provide: SecretBox, useFactory: () => new SecretBox() },
    AiRunsRecorder,
    AiAudience,
    AiStatus,
    DirectNotifier,
  ],
  exports: [AI_PROVIDER, SecretBox, AiRunsRecorder, AiAudience, AiStatus],
})
export class AiModule {}

/** AI HTTP routes (api process only). */
@Module({ controllers: [AiSettingsController, AiPoliciesController], providers: [AiSettingsService, AiPoliciesService] })
export class AiHttpModule {}
