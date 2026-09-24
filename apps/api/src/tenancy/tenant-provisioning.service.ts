import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { IANAZone } from 'luxon';

import { grantRegistryToAdminRole } from '../authorization/registry/registry.service.js';
import { TenantContext, type Actor } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { AppError, validationFailed } from '../platform-kernel/http/app-error.js';
import { RESERVED_SLUGS } from '../platform-kernel/http/tenant-resolver.middleware.js';
import { uuidv7 } from '../platform-kernel/ids.js';

import {
  PROVISIONING_CONTRIBUTOR,
  type ProvisionedTenant,
  type TenantProvisioningContributor,
} from './provisioning-contributor.js';

import type { PermissionKey } from '../authorization/registry/module-permissions.js';
import type { SystemRoleKey } from '../platform-kernel/db/tables/authorization.js';

/**
 * Creates a tenant with everything it needs to be used (FR-006, FR-024, data-model.md "Default
 * seed per tenant") in one transaction: the tenant, its settings, the `ticket_number` counter,
 * the four system roles with their permissions and Ungrouped access, then every registered
 * provisioning contributor. Any failure rolls the whole tenant back.
 *
 * Admin gets every registered permission through `grantRegistryToAdminRole` (the same path as
 * the start-up sync), so the registry must have synced `permission_definitions` first.
 */

export interface ProvisionInput {
  name: string;
  slug: string;
  timezone?: string;
}

const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9])*$/;
const TICKET_NUMBER_START = 1000;

const SYSTEM_ROLES: readonly { key: SystemRoleKey; name: string; description: string }[] = [
  { key: 'admin', name: 'Admin', description: 'Full access to the workspace' },
  { key: 'manager', name: 'Manager', description: 'Triage and manage tickets, views and reporting' },
  { key: 'agent', name: 'Agent', description: 'Work tickets in the groups the role grants' },
  { key: 'customer', name: 'Customer', description: 'Customers reach only their own conversation' },
];

/** data-model.md "Default seed per tenant". Admin is not listed: it always gets every key. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Exclude<SystemRoleKey, 'admin'>, readonly PermissionKey[]>> = {
  manager: [
    'ticket.view',
    'ticket.edit',
    'ticket.merge',
    'ticket.split',
    'ticket.bulk_update',
    'view.create',
    'view.view',
    'view.edit',
    'tag.view',
    'macro.view',
    'dashboard.view',
    'user.view',
  ],
  agent: ['ticket.view', 'ticket.edit', 'view.create', 'view.view', 'tag.view', 'macro.view', 'dashboard.view'],
  customer: [],
};

/** Ungrouped access per system role; other roles and all groups start with none. */
const DEFAULT_UNGROUPED_ACCESS: Readonly<Partial<Record<SystemRoleKey, { view: boolean; create: boolean; edit: boolean; delete: boolean }>>> = {
  admin: { view: true, create: true, edit: true, delete: true },
  manager: { view: true, create: false, edit: true, delete: false },
};

/** Input problems as `details[{ path, issue }]`; empty when the input is valid. */
export function provisionInputProblems(input: ProvisionInput): { path: string; issue: string }[] {
  const problems: { path: string; issue: string }[] = [];
  const name = input.name.trim();
  if (name.length === 0) problems.push({ path: 'name', issue: 'required' });
  else if (name.length > 120) problems.push({ path: 'name', issue: 'too_long' });
  if (input.slug.length < 3) problems.push({ path: 'slug', issue: 'too_short' });
  else if (input.slug.length > 40) problems.push({ path: 'slug', issue: 'too_long' });
  else if (!SLUG_PATTERN.test(input.slug)) problems.push({ path: 'slug', issue: 'invalid_format' });
  if (input.timezone !== undefined && !IANAZone.isValidZone(input.timezone)) {
    problems.push({ path: 'timezone', issue: 'invalid_timezone' });
  }
  return problems;
}

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private contributors: TenantProvisioningContributor[] = [];

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit(): void {
    this.contributors = this.discovery
      .getProviders()
      .filter((wrapper) => {
        const metatype = wrapper.metatype as object | null | undefined;
        return typeof metatype === 'function' && Reflect.getMetadata(PROVISIONING_CONTRIBUTOR, metatype) === true;
      })
      .map((wrapper) => wrapper.instance as TenantProvisioningContributor);
  }

  /**
   * 400 `VALIDATION_FAILED` for bad input, 409 `SLUG_RESERVED` / `SLUG_TAKEN` for unusable slugs.
   * `actor` is the operator creating the tenant, or system for the dev seed and tests.
   */
  async provision(
    input: ProvisionInput,
    options: { actor?: Actor; requestId?: string } = {},
  ): Promise<ProvisionedTenant> {
    const problems = provisionInputProblems(input);
    if (problems.length > 0) throw validationFailed(problems);
    if (RESERVED_SLUGS.has(input.slug)) {
      throw new AppError('SLUG_RESERVED', 409, 'This address is reserved');
    }

    const tenantId = uuidv7();
    const ctx = TenantContext.create({
      tenantId,
      actor: options.actor ?? { kind: 'system' },
      requestId: options.requestId ?? `provision-${tenantId}`,
    });
    try {
      return await this.unitOfWork.withTenant(ctx, async (tx) => {
        const repo = new ProvisioningRepository(ctx);
        await repo.insertTenant(tx, { id: tenantId, slug: input.slug, name: input.name.trim() });
        await repo.insertDefaults(tx, input.timezone ?? 'UTC');
        const roles = await repo.insertSystemRoles(tx);
        await grantRegistryToAdminRole(tx);
        await repo.grantDefaults(tx, roles);

        const tenant: ProvisionedTenant = { id: tenantId, slug: input.slug, name: input.name.trim(), roles };
        for (const contributor of this.contributors) {
          await contributor.contribute(tx, tenant);
        }
        return tenant;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_slug_key')) {
        throw new AppError('SLUG_TAKEN', 409, 'This address is already in use');
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const { code, constraint: name } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && name === constraint;
}

class ProvisioningRepository extends TenantRepository {
  async insertTenant(tx: TenantTransaction, tenant: { id: string; slug: string; name: string }): Promise<void> {
    // `tenants` is global; the app role may insert only (id, slug, name) (P2-2).
    await tx.insertInto('tenants').values(tenant).execute();
  }

  async insertDefaults(tx: TenantTransaction, timezone: string): Promise<void> {
    await this.insertInto(tx, 'tenant_settings', { timezone }).execute();
    await this.insertInto(tx, 'tenant_counters', { name: 'ticket_number', value: TICKET_NUMBER_START }).execute();
  }

  async insertSystemRoles(tx: TenantTransaction): Promise<ProvisionedTenant['roles']> {
    const rows = await this.insertInto(
      tx,
      'roles',
      SYSTEM_ROLES.map((role) => ({ name: role.name, description: role.description, system_key: role.key })),
    )
      .returning(['id', 'system_key'])
      .execute();
    const byKey = new Map(rows.map((row) => [row.system_key, row.id]));
    const id = (key: SystemRoleKey): string => {
      const value = byKey.get(key);
      if (value === undefined) throw new Error(`System role ${key} was not created`);
      return value;
    };
    return { admin: id('admin'), manager: id('manager'), agent: id('agent'), customer: id('customer') };
  }

  async grantDefaults(tx: TenantTransaction, roles: ProvisionedTenant['roles']): Promise<void> {
    const permissions = Object.entries(DEFAULT_ROLE_PERMISSIONS).flatMap(([key, keys]) =>
      keys.map((permission_key) => ({ role_id: roles[key as keyof typeof DEFAULT_ROLE_PERMISSIONS], permission_key })),
    );
    if (permissions.length > 0) await this.insertInto(tx, 'role_permissions', permissions).execute();

    const access = Object.entries(DEFAULT_UNGROUPED_ACCESS).map(([key, flags]) => ({
      role_id: roles[key as SystemRoleKey],
      group_id: null,
      can_view: flags.view,
      can_create: flags.create,
      can_edit: flags.edit,
      can_delete: flags.delete,
    }));
    await this.insertInto(tx, 'role_group_access', access).execute();
  }
}

/** Tenant lifecycle (US2 adds suspension, deletion and the console endpoints). */
@Module({
  imports: [DiscoveryModule],
  providers: [TenantProvisioningService],
  exports: [TenantProvisioningService],
})
export class TenancyModule {}
