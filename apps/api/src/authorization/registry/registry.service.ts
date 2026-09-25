import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { sql, type Kysely } from 'kysely';

import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { bumpAccessVersion } from '../access-version.js';

import { isModulePermissions, type ModulePermissions, type PermissionKey } from './module-permissions.js';

export interface PermissionDefinition {
  key: PermissionKey;
  resource: string;
  action: string;
  module: string;
  description: string;
}

export const REGISTRY_OPTIONS = Symbol('REGISTRY_OPTIONS');

export interface RegistryOptions {
  /** Sync definitions and Admin grants on start-up (the `api` process). */
  syncOnBootstrap: boolean;
}

const TENANT_PAGE_SIZE = 500;

/**
 * Grants every registered permission to the tenant's Admin role (FR-017, FR-024). Idempotent.
 * Used by the start-up sync and by tenant provisioning, so Admin access comes only from
 * `role_permissions` rows, never from a hard-coded bypass (constitution II).
 */
export async function grantRegistryToAdminRole(tx: TenantTransaction): Promise<number> {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('grantRegistryToAdminRole must run inside withTenant');
  const result = await tx
    .insertInto('role_permissions')
    .columns(['tenant_id', 'role_id', 'permission_key'])
    .expression((eb) =>
      eb
        .selectFrom('roles')
        .innerJoin('permission_definitions', (join) => join.onTrue())
        .select(['roles.tenant_id', 'roles.id', 'permission_definitions.key'])
        .where('roles.tenant_id', '=', ctx.tenantId)
        .where('roles.system_key', '=', 'admin'),
    )
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
}

/**
 * The permission registry (research D6): collects every module's `ModulePermissions` at start-up
 * and syncs them into `permission_definitions`. Definitions removed from code are kept (grants
 * referencing them stay valid) and only reported.
 */
@Injectable()
export class PermissionRegistry implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('PermissionRegistry');
  private readonly definitions = new Map<PermissionKey, PermissionDefinition>();

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(PLATFORM_DB) private readonly platformDb: Kysely<Database>,
    private readonly unitOfWork: UnitOfWork,
    @Inject(REGISTRY_OPTIONS) private readonly options: RegistryOptions,
  ) {}

  onModuleInit(): void {
    const declarations = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter(isModulePermissions);
    this.load(declarations);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.syncOnBootstrap) {
      await this.sync();
    }
  }

  /** Throws on duplicate keys: two modules must not declare the same resource action. */
  load(declarations: readonly ModulePermissions[]): void {
    this.definitions.clear();
    for (const declaration of declarations) {
      for (const { resource, actions } of declaration.resources) {
        for (const { action, description } of actions) {
          const key: PermissionKey = `${resource}.${action}`;
          if (this.definitions.has(key)) {
            throw new Error(`Permission ${key} is declared twice`);
          }
          this.definitions.set(key, { key, resource, action, module: declaration.module, description });
        }
      }
    }
  }

  has(key: string): key is PermissionKey {
    return this.definitions.has(key as PermissionKey);
  }

  all(): PermissionDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Upserts definitions, then makes sure every tenant's Admin role holds all of them. */
  async sync(): Promise<{ added: string[]; grants: number }> {
    const added = await this.upsertDefinitions();
    // Reconciles all keys, not just the added ones, so a crash between the two steps can never
    // leave an Admin role without a permission.
    const grants = await this.grantToAllAdminRoles();
    if (added.length > 0 || grants > 0) {
      this.logger.log(`Registered ${added.length} new permissions; granted ${grants} to Admin roles`);
    }
    return { added, grants };
  }

  private async upsertDefinitions(): Promise<string[]> {
    const definitions = this.all();
    if (definitions.length === 0) return [];
    return this.platformDb.transaction().execute(async (trx) => {
      // Serializes concurrent start-ups of several api instances.
      await sql`SELECT pg_advisory_xact_lock(hashtext('replyx:permission-registry'))`.execute(trx);
      const existing = new Set(
        (await trx.selectFrom('permission_definitions').select('key').execute()).map((row) => row.key),
      );
      await trx
        .insertInto('permission_definitions')
        .values(definitions)
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({
            resource: eb.ref('excluded.resource'),
            action: eb.ref('excluded.action'),
            module: eb.ref('excluded.module'),
            description: eb.ref('excluded.description'),
          })),
        )
        .execute();
      const stale = [...existing].filter((key) => !this.has(key));
      if (stale.length > 0) {
        this.logger.warn(`Permissions no longer declared in code: ${stale.join(', ')}`);
      }
      return definitions.map((d) => d.key).filter((key) => !existing.has(key));
    });
  }

  private async grantToAllAdminRoles(): Promise<number> {
    let granted = 0;
    let after: string | undefined;
    for (;;) {
      let query = this.platformDb.selectFrom('tenants').select('id').orderBy('id').limit(TENANT_PAGE_SIZE);
      if (after !== undefined) query = query.where('id', '>', after);
      const tenants = await query.execute();
      for (const { id } of tenants) {
        const ctx = TenantContext.create({ tenantId: id, actor: { kind: 'system' }, requestId: 'permission-registry' });
        granted += await this.unitOfWork.withTenant(ctx, async (tx) => {
          const added = await grantRegistryToAdminRole(tx);
          // Admins' cached effective access predates the new keys.
          if (added > 0) await bumpAccessVersion(tx, id, 'permission_registry');
          return added;
        });
      }
      if (tenants.length < TENANT_PAGE_SIZE) return granted;
      after = tenants.at(-1)?.id;
    }
  }
}
