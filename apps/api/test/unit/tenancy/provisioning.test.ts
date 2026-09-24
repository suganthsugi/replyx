import { describe, expect, it } from 'vitest';

import { INITIAL_PERMISSIONS } from '../../../src/authorization/registry/initial-permissions.js';
import { permissionKeys } from '../../../src/authorization/registry/module-permissions.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  provisionInputProblems,
} from '../../../src/tenancy/tenant-provisioning.service.js';

describe('tenant provisioning input', () => {
  it('accepts a valid name, slug and timezone', () => {
    expect(provisionInputProblems({ name: 'Acme', slug: 'acme', timezone: 'Europe/Berlin' })).toEqual([]);
    expect(provisionInputProblems({ name: 'A', slug: 'a-1-b' })).toEqual([]);
  });

  it('reports each invalid field', () => {
    expect(provisionInputProblems({ name: '  ', slug: 'ab', timezone: 'Mars/Base' })).toEqual([
      { path: 'name', issue: 'required' },
      { path: 'slug', issue: 'too_short' },
      { path: 'timezone', issue: 'invalid_timezone' },
    ]);
    expect(provisionInputProblems({ name: 'x'.repeat(121), slug: 'a'.repeat(41) })).toEqual([
      { path: 'name', issue: 'too_long' },
      { path: 'slug', issue: 'too_long' },
    ]);
    for (const slug of ['Acme', 'ac--me', '-acme', 'acme-', 'ac_me']) {
      expect(provisionInputProblems({ name: 'x', slug })).toEqual([{ path: 'slug', issue: 'invalid_format' }]);
    }
  });
});

describe('default role permissions', () => {
  it('only uses registered keys', () => {
    const registered = new Set(INITIAL_PERMISSIONS.flatMap(permissionKeys));
    for (const keys of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      for (const key of keys) expect(registered).toContain(key);
    }
  });

  it('matches data-model.md "Default seed per tenant"', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.customer).toEqual([]);
    expect(DEFAULT_ROLE_PERMISSIONS.agent).toHaveLength(7);
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('ticket.bulk_update');
    expect(DEFAULT_ROLE_PERMISSIONS.agent).not.toContain('ticket.merge');
  });
});
