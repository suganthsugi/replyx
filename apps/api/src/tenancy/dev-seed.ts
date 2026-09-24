import { pathToFileURL } from 'node:url';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { PasswordService } from '../identity/password.service.js';
import { isProduction } from '../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../platform-kernel/db/database.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';

import { DEFAULT_ROLE_PERMISSIONS, TenantProvisioningService } from './tenant-provisioning.service.js';

import type { ProvisionedTenant } from './provisioning-contributor.js';
import type { INestApplicationContext } from '@nestjs/common';
import type { Kysely } from 'kysely';

/**
 * Development seed (quickstart.md "The dev seed creates"): `pnpm --filter api seed:dev`.
 * Refused when NODE_ENV=production. Idempotent: an existing operator or tenant is left as is.
 *
 * - operator `OPERATOR_BOOTSTRAP_EMAIL` / `OPERATOR_BOOTSTRAP_PASSWORD`
 * - tenants `acme` and `globex` through provisioning, each with `admin@`, `manager@`, `agent@`
 *   (password `password-123456`) and `customer@{slug}.test`, groups Support and Billing, and a
 *   custom role "Support Agent" (the Agent permissions plus view + edit on Support) held by agent@
 * - the existing globex ticket is added by US1 (T044 note)
 */

export const SEED_STAFF_PASSWORD = 'password-123456';
const SEED_TENANTS = [
  { slug: 'acme', name: 'Acme', timezone: 'Europe/Berlin' },
  { slug: 'globex', name: 'Globex', timezone: 'America/New_York' },
] as const;

export interface SeedResult {
  operator: 'created' | 'exists';
  tenants: Record<string, 'created' | 'exists'>;
}

export async function seedDev(app: INestApplicationContext): Promise<SeedResult> {
  if (isProduction()) throw new Error('seed:dev is refused when NODE_ENV=production');
  const platformDb = app.get<Kysely<Database>>(PLATFORM_DB);
  const passwords = app.get(PasswordService);
  const provisioning = app.get(TenantProvisioningService);
  const unitOfWork = app.get(UnitOfWork);

  const result: SeedResult = { operator: await seedOperator(platformDb, passwords), tenants: {} };
  const staffHash = await passwords.hash(SEED_STAFF_PASSWORD);

  for (const spec of SEED_TENANTS) {
    const existing = await platformDb.selectFrom('tenants').select('id').where('slug', '=', spec.slug).executeTakeFirst();
    if (existing !== undefined) {
      result.tenants[spec.slug] = 'exists';
      continue;
    }
    const tenant = await provisioning.provision(spec);
    const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'seed-dev' });
    await unitOfWork.withTenant(ctx, (tx) => new SeedRepository(ctx).seed(tx, tenant, staffHash));
    result.tenants[spec.slug] = 'created';
  }
  return result;
}

async function seedOperator(db: Kysely<Database>, passwords: PasswordService): Promise<SeedResult['operator']> {
  const email = process.env.OPERATOR_BOOTSTRAP_EMAIL ?? 'operator@replyx.test';
  const password = process.env.OPERATOR_BOOTSTRAP_PASSWORD ?? 'operator-password';
  const row = await db
    .insertInto('platform_operators')
    .values({ email, name: 'Platform operator', password_hash: await passwords.hash(password) })
    .onConflict((oc) => oc.column('email').doNothing())
    .returning('id')
    .executeTakeFirst();
  return row === undefined ? 'exists' : 'created';
}

class SeedRepository extends TenantRepository {
  async seed(tx: TenantTransaction, tenant: ProvisionedTenant, staffHash: string): Promise<void> {
    const groups = await this.insertInto(tx, 'groups', [
      { name: 'Support', description: 'Customer questions and problems' },
      { name: 'Billing', description: 'Invoices, payments and plans' },
    ])
      .returning(['id', 'name'])
      .execute();
    const support = groups.find((group) => group.name === 'Support')?.id as string;

    const supportAgent = await this.insertInto(tx, 'roles', {
      name: 'Support Agent',
      description: 'Works tickets in the Support group',
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.insertInto(
      tx,
      'role_permissions',
      DEFAULT_ROLE_PERMISSIONS.agent.map((permission_key) => ({ role_id: supportAgent.id, permission_key })),
    ).execute();

    const full = { can_view: true, can_create: true, can_edit: true, can_delete: true };
    await this.insertInto(tx, 'role_group_access', [
      // Admin has full access to every group (data-model.md "Default seed per tenant").
      ...groups.map((group) => ({ role_id: tenant.roles.admin, group_id: group.id, ...full })),
      { role_id: supportAgent.id, group_id: support, can_view: true, can_create: false, can_edit: true, can_delete: false },
    ]).execute();

    const people = [
      { local: 'admin', name: 'Ada Admin', kind: 'staff' as const, role: tenant.roles.admin },
      { local: 'manager', name: 'Max Manager', kind: 'staff' as const, role: tenant.roles.manager },
      { local: 'agent', name: 'Ann Agent', kind: 'staff' as const, role: supportAgent.id },
      { local: 'customer', name: 'Cam Customer', kind: 'customer' as const, role: tenant.roles.customer },
    ];
    for (const person of people) {
      const user = await this.insertInto(tx, 'users', {
        email: `${person.local}@${tenant.slug}.test`,
        name: person.name,
        kind: person.kind,
        status: 'active',
        password_hash: person.kind === 'staff' ? staffHash : null,
      })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.insertInto(tx, 'user_roles', { user_id: user.id, role_id: person.role }).execute();
    }
  }
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const logger = new Logger('DevSeed');
  (async () => {
    if (isProduction()) throw new Error('seed:dev is refused when NODE_ENV=production');
    // The api role syncs the permission registry on bootstrap, which provisioning needs.
    const app = await NestFactory.createApplicationContext(AppModule.forRoot({ role: 'api' }), { logger: ['error', 'warn', 'log'] });
    try {
      const result = await seedDev(app);
      logger.log(`Seed done: operator ${result.operator}; ${Object.entries(result.tenants).map(([slug, state]) => `${slug} ${state}`).join(', ')}`);
    } finally {
      await app.close();
    }
  })().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
