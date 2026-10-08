import { definePermissions } from '../authorization/registry/module-permissions.js';

/**
 * AI Assist permissions (specs/002-ai-assist FR-027). Registered from `AiModule`; like
 * every registry key they are granted to each tenant's Admin role on start-up and to no other role.
 */
export const AiPermissions = definePermissions({
  module: 'ai',
  resources: [
    {
      resource: 'ai_settings',
      actions: [{ action: 'manage', description: 'Manage AI settings, the provider key and the store connection' }],
    },
    {
      resource: 'ai_knowledge',
      actions: [{ action: 'manage', description: 'Manage the policy documents the assistant answers from' }],
    },
    {
      resource: 'ai_usage',
      actions: [{ action: 'view', description: 'View AI usage and cost' }],
    },
  ],
});
