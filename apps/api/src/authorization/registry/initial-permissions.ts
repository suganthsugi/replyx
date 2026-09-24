import { definePermissions, type ModulePermissions } from './module-permissions.js';

/**
 * The initial permission registry (data-model.md "Initial permission registry", FR-018), grouped
 * by owning module. Modules built later register these same declarations from their own module
 * files; this list is the whole registry until then, and adding a key here grants it to every
 * tenant's Admin role on the next start-up (and to no other role, FR-017).
 */
const crud = (noun: string) => [
  { action: 'create', description: `Create ${noun}` },
  { action: 'view', description: `View ${noun}` },
  { action: 'edit', description: `Edit ${noun}` },
  { action: 'delete', description: `Delete ${noun}` },
];

export const INITIAL_PERMISSIONS: readonly ModulePermissions[] = [
  definePermissions({
    module: 'identity',
    resources: [
      {
        resource: 'user',
        actions: [...crud('users'), { action: 'erase', description: "Erase a user's personal data" }],
      },
    ],
  }),
  definePermissions({
    module: 'authorization',
    resources: [{ resource: 'role', actions: crud('roles') }],
  }),
  definePermissions({
    module: 'groups',
    resources: [{ resource: 'group', actions: crud('groups') }],
  }),
  definePermissions({
    module: 'tickets',
    resources: [
      {
        resource: 'ticket',
        actions: [
          ...crud('tickets'),
          { action: 'merge', description: 'Merge tickets' },
          { action: 'split', description: 'Split a ticket' },
          { action: 'bulk_update', description: 'Update many tickets at once' },
          { action: 'move_message', description: 'Move a message to another ticket' },
        ],
      },
    ],
  }),
  definePermissions({
    module: 'views',
    resources: [
      {
        resource: 'view',
        actions: [...crud('views'), { action: 'share', description: 'Share views with roles, groups or all staff' }],
      },
    ],
  }),
  definePermissions({
    module: 'tags',
    resources: [{ resource: 'tag', actions: crud('tags') }],
  }),
  definePermissions({
    module: 'messaging',
    resources: [{ resource: 'macro', actions: crud('macros') }],
  }),
  definePermissions({
    module: 'sla',
    resources: [
      { resource: 'sla_policy', actions: crud('SLA policies') },
      { resource: 'dashboard', actions: [{ action: 'view', description: 'View the dashboard' }] },
    ],
  }),
  definePermissions({
    module: 'routing',
    resources: [
      { resource: 'routing_rule', actions: crud('routing rules') },
      { resource: 'automation_rule', actions: crud('automation rules') },
    ],
  }),
  definePermissions({
    module: 'integrations',
    resources: [{ resource: 'webhook', actions: crud('webhooks') }],
  }),
  definePermissions({
    module: 'tenancy',
    resources: [
      {
        resource: 'tenant_settings',
        actions: [
          { action: 'view', description: 'View organization settings' },
          { action: 'edit', description: 'Edit organization settings' },
        ],
      },
      {
        resource: 'support_access',
        actions: [
          { action: 'view', description: 'View support access grants' },
          { action: 'create', description: 'Grant platform support access' },
          { action: 'delete', description: 'Revoke platform support access' },
        ],
      },
    ],
  }),
  definePermissions({
    module: 'audit',
    resources: [{ resource: 'audit_log', actions: [{ action: 'view', description: 'View the audit log' }] }],
  }),
];
