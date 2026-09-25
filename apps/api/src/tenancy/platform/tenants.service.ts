import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { InvitationsService } from '../../identity/invitations.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { PLATFORM_DB, type Database } from '../../platform-kernel/db/database.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { AppError, notFound } from '../../platform-kernel/http/app-error.js';
import { decodeCursor, toPage, type Page } from '../../platform-kernel/http/pagination.js';
import { TenantProvisioningService } from '../tenant-provisioning.service.js';

import type { Kysely } from 'kysely';

/**
 * The console's view of a tenant (contracts/platform.yaml `/tenants*`, FR-001). Operators see
 * what they need to run the platform — name, slug, status, aggregate counts — and never business
 * content: no ticket, message or customer rows leave this service.
 *
 * `tenants` is a global table, so the list and the details read through `PLATFORM_DB`. The one
 * place this service enters a tenant is creating its first admin invitation, which runs in that
 * tenant's own transaction like any other write.
 */

export interface TenantStats {
  staffUsers: number;
  customers: number;
  ticketsLast30Days: number;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  createdAt: string;
  suspendedAt: string | null;
  activeSupportGrantUntil: string | null;
  stats: TenantStats;
}

export interface TenantFilters {
  status?: 'active' | 'suspended';
  q?: string;
  limit: number;
  cursor?: string;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  timezone?: string;
}

/** The operator performing the action, for audit entries written in the tenant's own log. */
export interface OperatorActor {
  operatorId: string;
  requestId: string;
  ip: string | null;
}

const Cursor = z.object({ id: z.uuid() }).strict();

export function tenantNotFound(): AppError {
  return notFound('tenant');
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Kysely<Database>,
    private readonly provisioning: TenantProvisioningService,
    private readonly unitOfWork: UnitOfWork,
    private readonly invitations: InvitationsService,
    private readonly clock: Clock,
  ) {}

  async list(filters: TenantFilters): Promise<Page<TenantDto>> {
    const after = filters.cursor === undefined ? undefined : decodeCursor(filters.cursor, Cursor);
    let query = this.db.selectFrom('tenants').select(['id', 'slug', 'name', 'status', 'suspended_at', 'created_at']);
    if (filters.status !== undefined) query = query.where('status', '=', filters.status);
    if (filters.q !== undefined && filters.q.trim() !== '') {
      const pattern = `%${filters.q.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      query = query.where((eb) => eb.or([eb('name', 'ilike', pattern), eb('slug', 'ilike', pattern)]));
    }
    if (after !== undefined) query = query.where('id', '<', after.id);
    const rows = await query.orderBy('id', 'desc').limit(filters.limit + 1).execute();

    const page = toPage(rows, filters.limit, (row) => ({ id: row.id }), (row) => row);
    const stats = await this.statsFor(page.items.map((row) => row.id));
    return { ...page, items: page.items.map((row) => this.toDto(row, stats)) };
  }

  async get(tenantId: string): Promise<TenantDto> {
    const row = await this.db
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'status', 'suspended_at', 'created_at'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) throw tenantNotFound();
    return this.toDto(row, await this.statsFor([tenantId]));
  }

  /** Creates the tenant and invites its first admin; 409 `SLUG_TAKEN` / `SLUG_RESERVED`. */
  async create(input: CreateTenantInput, actor: OperatorActor): Promise<TenantDto> {
    const tenant = await this.provisioning.provision(
      { name: input.name, slug: input.slug, ...(input.timezone === undefined ? {} : { timezone: input.timezone }) },
      { actor: { kind: 'operator', id: actor.operatorId }, requestId: actor.requestId },
    );

    const ctx = this.contextFor(tenant.id, actor);
    const invitation = await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TenantAdminRepository(ctx);
      const userId = await repo.insertAdmin(tx, input.adminEmail, tenant.roles.admin);
      return this.invitations.create(tx, { userId, email: input.adminEmail, roleIds: [tenant.roles.admin], invitedBy: null });
    });
    // Mail only after the invitation is committed (realtime-events rule 11).
    await this.invitations.sendEmail(tenant, invitation, 'The ReplyX team');

    return this.get(tenant.id);
  }

  async update(tenantId: string, input: { name?: string }): Promise<TenantDto> {
    await this.requireTenant(tenantId);
    if (input.name !== undefined) {
      await this.db.updateTable('tenants').set({ name: input.name }).where('id', '=', tenantId).execute();
    }
    return this.get(tenantId);
  }

  /** Throws the same 404 as an unknown id; used by suspension and support access too. */
  async requireTenant(tenantId: string): Promise<{ id: string; slug: string; name: string; status: 'active' | 'suspended' }> {
    const row = await this.db
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'status'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (row === undefined) throw tenantNotFound();
    return row;
  }

  contextFor(tenantId: string, actor: OperatorActor): TenantContext {
    return TenantContext.create({
      tenantId,
      actor: { kind: 'operator', id: actor.operatorId },
      requestId: actor.requestId,
      ip: actor.ip,
    });
  }

  /**
   * Aggregate counts per tenant. `users` and `support_access_grants` are tenant tables, and
   * `replyx_platform` deliberately has no grant on them (tenant-scoping rule 10), so each tenant's
   * numbers are read in that tenant's own read-only transaction as `replyx_app`, under RLS. A
   * console page is at most 100 tenants, so the per-tenant round trip is affordable.
   */
  private async statsFor(tenantIds: readonly string[]): Promise<Map<string, TenantStats & { grantUntil: string | null }>> {
    const result = new Map<string, TenantStats & { grantUntil: string | null }>();
    const entries = await Promise.all(tenantIds.map(async (id) => [id, await this.statsForTenant(id)] as const));
    for (const [id, stats] of entries) result.set(id, stats);
    return result;
  }

  private statsForTenant(tenantId: string): Promise<TenantStats & { grantUntil: string | null }> {
    const ctx = TenantContext.create({ tenantId, actor: { kind: 'system' }, requestId: `tenant-stats-${tenantId}` });
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new TenantStatsRepository(ctx);
      const [users, grant] = await Promise.all([repo.userCounts(tx), repo.activeGrantExpiry(tx, this.clock.now())]);
      const byKind = new Map(users.map((row) => [row.kind, Number(row.count)]));
      return {
        staffUsers: byKind.get('staff') ?? 0,
        customers: byKind.get('customer') ?? 0,
        // `tickets` arrives with US1 (T101); until then the count stays 0 rather than failing.
        ticketsLast30Days: 0,
        grantUntil: grant?.expires_at?.toISOString() ?? null,
      };
    });
  }

  private toDto(
    row: { id: string; slug: string; name: string; status: 'active' | 'suspended'; suspended_at: Date | null; created_at: Date },
    stats: Map<string, TenantStats & { grantUntil: string | null }>,
  ): TenantDto {
    const entry = stats.get(row.id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      suspendedAt: row.suspended_at?.toISOString() ?? null,
      activeSupportGrantUntil: entry?.grantUntil ?? null,
      stats: {
        staffUsers: entry?.staffUsers ?? 0,
        customers: entry?.customers ?? 0,
        ticketsLast30Days: entry?.ticketsLast30Days ?? 0,
      },
    };
  }
}

class TenantStatsRepository extends TenantRepository {
  userCounts(tx: TenantTransaction) {
    return this.selectFrom(tx, 'users')
      .select(['kind', (eb) => eb.fn.countAll<string>().as('count')])
      .where('erased_at', 'is', null)
      .groupBy('kind')
      .execute();
  }

  activeGrantExpiry(tx: TenantTransaction, now: Date) {
    return this.selectFrom(tx, 'support_access_grants')
      .select((eb) => eb.fn.max('expires_at').as('expires_at'))
      .where('revoked_at', 'is', null)
      .where('starts_at', '<=', now)
      .where('expires_at', '>', now)
      .executeTakeFirst();
  }
}

class TenantAdminRepository extends TenantRepository {
  /** The invited admin of a brand-new tenant: `invited` until they accept (FR-006). */
  async insertAdmin(tx: TenantTransaction, email: string, adminRoleId: string): Promise<string> {
    const user = await this.insertInto(tx, 'users', {
      email,
      name: email.split('@')[0]?.slice(0, 120) ?? 'Administrator',
      kind: 'staff',
      status: 'invited',
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.insertInto(tx, 'user_roles', { user_id: user.id, role_id: adminRoleId }).execute();
    return user.id;
  }
}
