import { randomBytes } from 'node:crypto';

import { bumpAccessVersion } from '../../src/authorization/access-version.js';
import { PasswordService } from '../../src/identity/password.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository, type TenantInsert } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../src/platform-kernel/ids.js';
import { TenantProvisioningService } from '../../src/tenancy/tenant-provisioning.service.js';
import { TicketNumberService } from '../../src/tickets/ticket-number.service.js';

import { getTestApp, service } from './app.js';

import type { ProvisionedTenant } from '../../src/tenancy/provisioning-contributor.js';

/**
 * Test data factories (testing-conventions rule 4). Every factory takes an explicit tenant;
 * tenants are created through the real provisioning service, so system roles and the registry
 * grants exist exactly as in production. Data is fake (`@example.test`, random slugs).
 */

export interface TestTenant extends ProvisionedTenant {
  /** The tenant's host, e.g. `tenant-a1b2c3.localhost`. */
  host: string;
}

export type SystemRole = keyof ProvisionedTenant['roles'];
/** A system role by key, or any role by id. */
export type RoleRef = SystemRole | { id: string };

export interface TestUser {
  id: string;
  email: string;
  name: string;
  kind: 'staff' | 'customer';
  tenant: TestTenant;
  /** Raw session token for the `rx_session` cookie (absent with `session: false`). */
  sessionToken?: string;
  sessionId?: string;
  /** Value of the `rx_csrf` cookie and `X-CSRF-Token` header. */
  csrfToken: string;
  password?: string;
}

export interface GroupFlags {
  view?: boolean;
  create?: boolean;
  edit?: boolean;
  delete?: boolean;
}

export interface TestGroup {
  id: string;
  name: string;
  tenant: TestTenant;
}

const unique = () => randomBytes(4).toString('hex');

function systemContext(tenant: { id: string }): TenantContext {
  return TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'test-factory' });
}

async function inTenant<T>(tenant: { id: string }, fn: (tx: TenantTransaction, repo: FactoryRepository) => Promise<T>): Promise<T> {
  const ctx = systemContext(tenant);
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(tx, new FactoryRepository(ctx)));
}

function roleId(tenant: TestTenant, role: RoleRef): string {
  return typeof role === 'string' ? tenant.roles[role] : role.id;
}

export async function createTenant(options: { name?: string; slug?: string; timezone?: string } = {}): Promise<TestTenant> {
  const slug = options.slug ?? `tenant-${unique()}`;
  const tenant = await (await service(TenantProvisioningService)).provision({
    name: options.name ?? `Tenant ${slug}`,
    slug,
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  });
  return { ...tenant, host: `${slug}.localhost` };
}

/**
 * An active user with the given roles and, by default, a signed-in session. `kind` defaults to
 * `customer` when the only role is `customer`, else `staff`.
 */
export async function createUser(
  tenant: TestTenant,
  options: {
    roles?: RoleRef[];
    kind?: 'staff' | 'customer';
    status?: 'invited' | 'active' | 'deactivated';
    email?: string;
    name?: string;
    password?: string;
    session?: boolean;
  } = {},
): Promise<TestUser> {
  const roles = options.roles ?? [];
  const kind = options.kind ?? (roles.length === 1 && roles[0] === 'customer' ? 'customer' : 'staff');
  const email = options.email ?? `${kind}-${unique()}@example.test`;
  const name = options.name ?? `${kind === 'staff' ? 'Staff' : 'Customer'} ${unique()}`;
  const passwordHash = options.password === undefined ? null : await (await service(PasswordService)).hash(options.password);
  const sessions = await service(SessionService);

  return inTenant(tenant, async (tx, repo) => {
    const id = await repo.insertUser(tx, { email, name, kind, status: options.status ?? 'active', passwordHash });
    await repo.assignRoles(tx, id, roles.map((role) => roleId(tenant, role)));
    const user: TestUser = {
      id,
      email,
      name,
      kind,
      tenant,
      csrfToken: randomBytes(32).toString('base64url'),
      ...(options.password === undefined ? {} : { password: options.password }),
    };
    if (options.session !== false) {
      const { token, principal } = await sessions.create(tx, { userId: id, kind });
      user.sessionToken = token;
      user.sessionId = principal.sessionId;
    }
    return user;
  });
}

/** A group with full Admin access (as group creation grants) plus the given role access. */
export async function createGroup(
  tenant: TestTenant,
  options: { name?: string; status?: 'active' | 'inactive'; access?: { role: RoleRef; flags: GroupFlags }[] } = {},
): Promise<TestGroup> {
  const name = options.name ?? `Group ${unique()}`;
  const id = await inTenant(tenant, async (tx, repo) => {
    const groupId = await repo.insertGroup(tx, name, options.status ?? 'active');
    await repo.setGroupAccess(tx, tenant.roles.admin, groupId, { view: true, create: true, edit: true, delete: true });
    for (const { role, flags } of options.access ?? []) {
      await repo.setGroupAccess(tx, roleId(tenant, role), groupId, flags);
    }
    await bumpAccessVersion(tx, tenant.id, 'test_group_created');
    return groupId;
  });
  return { id, name, tenant };
}

/** A custom role with registry permissions and group access (`group: null` = Ungrouped). */
export async function createRole(
  tenant: TestTenant,
  options: { name?: string; permissions?: string[]; groups?: { group: string | null; flags: GroupFlags }[] } = {},
): Promise<{ id: string; name: string }> {
  const name = options.name ?? `Role ${unique()}`;
  const id = await inTenant(tenant, async (tx, repo) => {
    const roleIdValue = await repo.insertRole(tx, name);
    await repo.grantPermissions(tx, roleIdValue, options.permissions ?? []);
    for (const { group, flags } of options.groups ?? []) {
      await repo.setGroupAccess(tx, roleIdValue, group, flags);
    }
    await bumpAccessVersion(tx, tenant.id, 'test_role_created');
    return roleIdValue;
  });
  return { id, name };
}

/** Sets (replaces) one role's access to a group and bumps the access version, like the role editor. */
export async function setGroupAccess(tenant: TestTenant, role: RoleRef, group: string | null, flags: GroupFlags): Promise<void> {
  await inTenant(tenant, async (tx, repo) => {
    await repo.setGroupAccess(tx, roleId(tenant, role), group, flags);
    await bumpAccessVersion(tx, tenant.id, 'test_group_access_changed');
  });
}

export interface TestTicket {
  id: string;
  number: number;
  tenant: TestTenant;
}

type TicketStateName = 'new' | 'open' | 'pending_reminder' | 'pending_close' | 'resolved' | 'closed';

/**
 * A ticket inserted directly (no routing, no events), with the timer columns its state needs.
 * `messages` are public customer messages unless `staff` is given. Use the API when the test is
 * about how tickets come to exist.
 */
export async function createTicket(
  tenant: TestTenant,
  options: {
    customer: TestUser;
    group?: string | null;
    owner?: string | null;
    state?: TicketStateName;
    title?: string;
    /** Resolved tickets close this long after `now` (default 72 h). */
    autoCloseAt?: Date;
    now?: Date;
    messages?: { body: string; staff?: TestUser; visibility?: 'public' | 'internal' }[];
  },
): Promise<TestTicket> {
  const state = options.state ?? 'new';
  // The app's clock, so rows line up with what the API writes during the test.
  const now = options.now ?? (await getTestApp()).clock.now();
  const later = new Date(now.getTime() + 72 * 3_600_000);
  // Resolved and closed after its messages (one per millisecond from now).
  const ended = new Date(now.getTime() + (options.messages?.length ?? 0));
  const numbers = await service(TicketNumberService);
  return inTenant(tenant, async (tx, repo) => {
    const number = await numbers.next(tx);
    const id = await repo.insertTicket(tx, {
      number,
      title: options.title ?? `Ticket ${number}`,
      customer_id: options.customer.id,
      group_id: options.group ?? null,
      owner_id: options.owner ?? null,
      state,
      origin: 'customer_message',
      pending_until: state === 'pending_reminder' || state === 'pending_close' ? later : null,
      resolved_at: state === 'resolved' || state === 'closed' ? ended : null,
      auto_close_at: state === 'resolved' ? (options.autoCloseAt ?? later) : null,
      closed_at: state === 'closed' ? ended : null,
      created_at: now,
    });
    for (const [index, message] of (options.messages ?? []).entries()) {
      await repo.insertMessage(tx, {
        created_at: new Date(now.getTime() + index),
        ticket_id: id,
        author_id: message.staff?.id ?? options.customer.id,
        author_kind: message.staff === undefined ? 'customer' : 'staff',
        visibility: message.visibility ?? 'public',
        body: message.body,
      });
    }
    return { id, number, tenant };
  });
}

class FactoryRepository extends TenantRepository {
  async insertTicket(tx: TenantTransaction, values: TenantInsert<'tickets'>): Promise<string> {
    const row = await this.insertInto(tx, 'tickets', values).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  async insertMessage(tx: TenantTransaction, values: TenantInsert<'ticket_messages'>): Promise<void> {
    await this.insertInto(tx, 'ticket_messages', { ...values, id: uuidv7() }).execute();
  }

  async insertUser(
    tx: TenantTransaction,
    user: { email: string; name: string; kind: 'staff' | 'customer'; status: 'invited' | 'active' | 'deactivated'; passwordHash: string | null },
  ): Promise<string> {
    const row = await this.insertInto(tx, 'users', {
      email: user.email,
      name: user.name,
      kind: user.kind,
      status: user.status,
      password_hash: user.passwordHash,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async assignRoles(tx: TenantTransaction, userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    await this.insertInto(tx, 'user_roles', roleIds.map((role_id) => ({ user_id: userId, role_id }))).execute();
  }

  async insertGroup(tx: TenantTransaction, name: string, status: 'active' | 'inactive'): Promise<string> {
    const row = await this.insertInto(tx, 'groups', { name, status }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  async insertRole(tx: TenantTransaction, name: string): Promise<string> {
    const row = await this.insertInto(tx, 'roles', { name }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  async grantPermissions(tx: TenantTransaction, roleIdValue: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.insertInto(tx, 'role_permissions', keys.map((permission_key) => ({ role_id: roleIdValue, permission_key }))).execute();
  }

  async setGroupAccess(tx: TenantTransaction, roleIdValue: string, groupId: string | null, flags: GroupFlags): Promise<void> {
    await this.deleteFrom(tx, 'role_group_access')
      .where('role_id', '=', roleIdValue)
      .where('group_id', groupId === null ? 'is' : '=', groupId)
      .execute();
    await this.insertInto(tx, 'role_group_access', {
      role_id: roleIdValue,
      group_id: groupId,
      can_view: flags.view ?? false,
      can_create: flags.create ?? false,
      can_edit: flags.edit ?? false,
      can_delete: flags.delete ?? false,
    }).execute();
  }
}
