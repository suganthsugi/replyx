import { Global, Module } from '@nestjs/common';

import { permissionsProvider } from '../authorization/registry/module-permissions.js';

import { AiAudience } from './ai-audience.js';
import { AiPermissions } from './ai.permissions.js';
import { AI_PROVIDER } from './providers/ports.js';
import { providerFromEnv } from './providers/provider-from-env.js';
import { AiRunsRecorder } from './runs/ai-runs.recorder.js';

/**
 * AI Assist (specs/002-ai-assist), shared by the api and worker processes: the permissions, the
 * provider chosen by `AI_PROVIDER`, the run recorder and the admin event audience. Global because
 * messaging, routing and SLA ask it about the assistant. HTTP controllers and queue consumers are
 * added by the story modules.
 */
@Global()
@Module({
  providers: [
    permissionsProvider(AiPermissions),
    { provide: AI_PROVIDER, useFactory: () => providerFromEnv() },
    AiRunsRecorder,
    AiAudience,
  ],
  exports: [AI_PROVIDER, AiRunsRecorder, AiAudience],
})
export class AiModule {}
