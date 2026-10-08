import { Injectable } from '@nestjs/common';
import { sql, type SqlBool } from 'kysely';

import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';

import type { PermissionKey } from '../authorization/registry/module-permissions.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import type { StreamKey } from '../platform-kernel/outbox/event-types.js';

/**
 * Who hears admin-side AI events (specs/002-ai-assist contracts/realtime-events.md): the `user`
 * streams of active staff holding a permission, resolved when the event is appended. Streams must
 * not be empty, so a tenant with no holder gets the `tenant` control stream (published to no socket).
 */
@Injectable()
export class AiAudience {
  async streamsFor(tx: TenantTransaction, ctx: TenantContext, permission: PermissionKey): Promise<StreamKey[]> {
    return streamsOf(await this.holderIds(tx, ctx, permission));
  }

  /** Active staff holding the permission, by id. */
  holderIds(tx: TenantTransaction, ctx: TenantContext, permission: PermissionKey): Promise<string[]> {
    return new AudienceRepository(ctx).holderIds(tx, permission);
  }
}

/** `user` streams for the ids, or the `tenant` control stream when there are none. */
export function streamsOf(userIds: readonly string[]): StreamKey[] {
  return userIds.length === 0 ? ['tenant'] : userIds.map((id): StreamKey => `user:${id}`);
}

class AudienceRepository extends TenantRepository {
  async holderIds(tx: TenantTransaction, permission: PermissionKey): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'users')
      .select('users.id')
      .where('users.status', '=', 'active')
      .where('users.kind', '=', 'staff')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('user_roles')
            .innerJoin('role_permissions', (join) =>
              join
                .onRef('role_permissions.tenant_id', '=', 'user_roles.tenant_id')
                .onRef('role_permissions.role_id', '=', 'user_roles.role_id'),
            )
            .select(sql<SqlBool>`1`.as('one'))
            .whereRef('user_roles.tenant_id', '=', 'users.tenant_id')
            .whereRef('user_roles.user_id', '=', 'users.id')
            .where('role_permissions.permission_key', '=', permission),
        ),
      )
      .orderBy('users.id')
      .execute();
    return rows.map((row) => row.id);
  }
}
