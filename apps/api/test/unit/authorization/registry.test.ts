import { describe, expect, it } from 'vitest';

import { INITIAL_PERMISSIONS } from '../../../src/authorization/registry/initial-permissions.js';
import {
  CustomerApi,
  definePermissions,
  isModulePermissions,
  OperatorApi,
  permissionKeys,
  Public,
  RequirePermission,
  routeAccessOf,
} from '../../../src/authorization/registry/module-permissions.js';
import { PermissionRegistry } from '../../../src/authorization/registry/registry.service.js';

/** data-model.md "Initial permission registry", verbatim. */
const EXPECTED: Record<string, string[]> = {
  user: ['create', 'view', 'edit', 'delete', 'erase'],
  role: ['create', 'view', 'edit', 'delete'],
  group: ['create', 'view', 'edit', 'delete'],
  ticket: ['create', 'view', 'edit', 'delete', 'merge', 'split', 'bulk_update', 'move_message'],
  view: ['create', 'view', 'edit', 'delete', 'share'],
  tag: ['create', 'view', 'edit', 'delete'],
  macro: ['create', 'view', 'edit', 'delete'],
  sla_policy: ['create', 'view', 'edit', 'delete'],
  routing_rule: ['create', 'view', 'edit', 'delete'],
  automation_rule: ['create', 'view', 'edit', 'delete'],
  webhook: ['create', 'view', 'edit', 'delete'],
  tenant_settings: ['view', 'edit'],
  support_access: ['view', 'create', 'delete'],
  audit_log: ['view'],
  dashboard: ['view'],
};

function registryWith(declarations = INITIAL_PERMISSIONS) {
  const registry = new PermissionRegistry(null as never, null as never, null as never, { syncOnBootstrap: false });
  registry.load(declarations);
  return registry;
}

describe('initial permission registry', () => {
  it('declares exactly the data-model table', () => {
    const expected = Object.entries(EXPECTED).flatMap(([resource, actions]) => actions.map((a) => `${resource}.${a}`));
    const declared = INITIAL_PERMISSIONS.flatMap(permissionKeys);
    expect(declared.sort()).toEqual(expected.sort());
    expect(declared).toHaveLength(57);
  });

  it('describes every permission', () => {
    for (const definition of registryWith().all()) {
      expect(definition.description.length).toBeGreaterThan(3);
      expect(definition.key).toBe(`${definition.resource}.${definition.action}`);
    }
  });
});

describe('PermissionRegistry.load', () => {
  it('rejects the same key declared by two modules', () => {
    const twice = [
      definePermissions({ module: 'a', resources: [{ resource: 'thing', actions: [{ action: 'view', description: 'View' }] }] }),
      definePermissions({ module: 'b', resources: [{ resource: 'thing', actions: [{ action: 'view', description: 'View' }] }] }),
    ];
    expect(() => registryWith(twice)).toThrow('thing.view is declared twice');
  });

  it('answers has() for declared keys only', () => {
    const registry = registryWith();
    expect(registry.has('ticket.merge')).toBe(true);
    expect(registry.has('ticket.teleport')).toBe(false);
  });
});

describe('definePermissions', () => {
  it('rejects names that are not snake_case', () => {
    expect(() => definePermissions({ module: 'x', resources: [{ resource: 'Ticket', actions: [] }] })).toThrow('Invalid permission name');
    expect(() => definePermissions({ module: 'x', resources: [{ resource: 't', actions: [{ action: 'do-it', description: 'd' }] }] })).toThrow();
  });

  it('brands declarations so discovery can find them', () => {
    expect(isModulePermissions(INITIAL_PERMISSIONS[0])).toBe(true);
    expect(isModulePermissions({ module: 'x', resources: [] })).toBe(false);
  });
});

describe('route access decorators', () => {
  @CustomerApi()
  class Controller {
    @RequirePermission('ticket.view')
    view(this: void) {}

    @Public()
    @OperatorApi()
    twice(this: void) {}

    inherited(this: void) {}
  }

  it('records the handler entry, falling back to the controller', () => {
    expect(routeAccessOf(Controller.prototype.view, Controller)).toEqual([{ kind: 'permission', permission: 'ticket.view' }]);
    expect(routeAccessOf(Controller.prototype.inherited, Controller)).toEqual([{ kind: 'customer' }]);
  });

  it('keeps every entry so the route audit can reject duplicates', () => {
    expect(routeAccessOf(Controller.prototype.twice, Controller)).toHaveLength(2);
  });
});
