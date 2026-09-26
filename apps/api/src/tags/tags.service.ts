import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { TenantContext } from '../platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../platform-kernel/db/tenant-repository.js';
import { tenantScopeOf, UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { conflict, notFound } from '../platform-kernel/http/app-error.js';

/**
 * Tags (data-model.md "tags, ticket_tags, customer_tags", contracts/tickets.yaml `/tags*`).
 *
 * Names are 1–40 chars, unique per tenant case-insensitively (DB index `tags_tenant_name`); the
 * unique violation is surfaced as 409 `TAG_NAME_TAKEN`. Deleting a tag cascades to `ticket_tags`
 * and `customer_tags` (FK `ON DELETE CASCADE`, migration 0009), so no explicit cleanup is needed.
 *
 * Ticket and customer tag sets are owned by the tickets and customers modules; this service only
 * exposes `assertTagsExist`, `setTicketTags`/`setCustomerTags` and the `tagsBy*` lookups so those
 * modules can validate and read tags without duplicating the tenant-scoped queries. All of these
 * take a `TenantTransaction` and derive the tenant from it (tenant-scoping rule 4), so a caller
 * joins the transaction it already opened.
 */

export interface TagDto {
  id: string;
  name: string;
}

type TagRow = { id: string; name: string };

@Injectable()
export class TagsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  list(ctx: TenantContext, filters: { q?: string }): Promise<TagDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const rows = await new TagsRepository(ctx).list(tx, filters.q);
      return rows.map(toDto);
    });
  }

  async create(ctx: TenantContext, input: { name: string }): Promise<TagDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TagsRepository(ctx);
      const tagId = await nameTaken(() => repo.insert(tx, { name: input.name }));
      await this.audit.record(tx, { action: 'tag.created', resourceType: 'tag', resourceId: tagId, details: { name: input.name } });
      const row = await repo.byId(tx, tagId);
      if (row === undefined) throw notFound('tag');
      return toDto(row);
    });
  }

  async update(ctx: TenantContext, tagId: string, input: { name: string }): Promise<TagDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TagsRepository(ctx);
      const row = await repo.byId(tx, tagId);
      if (row === undefined) throw notFound('tag');
      if (input.name !== row.name) {
        await nameTaken(() => repo.update(tx, tagId, input.name));
        await this.audit.record(tx, { action: 'tag.updated', resourceType: 'tag', resourceId: tagId, details: { name: input.name } });
      }
      return { id: tagId, name: input.name };
    });
  }

  async delete(ctx: TenantContext, tagId: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new TagsRepository(ctx);
      const row = await repo.byId(tx, tagId);
      if (row === undefined) throw notFound('tag');
      await repo.delete(tx, tagId);
      await this.audit.record(tx, { action: 'tag.deleted', resourceType: 'tag', resourceId: tagId, details: { name: row.name } });
    });
  }

  /** Throws 404 `TAG_NOT_FOUND` if any id is not one of the tenant's tags. */
  async assertTagsExist(tx: TenantTransaction, tagIds: readonly string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    const rows = await new TagsRepository(requireScope(tx)).byIds(tx, unique);
    if (rows.length !== unique.length) throw notFound('tag');
  }

  /** Replaces a ticket's full tag set; does not validate the ids (call `assertTagsExist` first). */
  async setTicketTags(tx: TenantTransaction, ticketId: string, tagIds: readonly string[]): Promise<void> {
    await new TagsRepository(requireScope(tx)).replaceTicketTags(tx, ticketId, [...new Set(tagIds)]);
  }

  /** Replaces a customer's full tag set; does not validate the ids (call `assertTagsExist` first). */
  async setCustomerTags(tx: TenantTransaction, userId: string, tagIds: readonly string[]): Promise<void> {
    await new TagsRepository(requireScope(tx)).replaceCustomerTags(tx, userId, [...new Set(tagIds)]);
  }

  /** Tags per ticket id, for building `TicketSummary.tags`; ticket ids without any are absent. */
  tagsByTicketIds(tx: TenantTransaction, ticketIds: readonly string[]): Promise<Map<string, TagDto[]>> {
    return new TagsRepository(requireScope(tx)).tagsByTicketIds(tx, ticketIds);
  }

  /** Tags per customer (user) id, for building `CustomerProfile.tags`; absent when there are none. */
  tagsByUserIds(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, TagDto[]>> {
    return new TagsRepository(requireScope(tx)).tagsByUserIds(tx, userIds);
  }
}

function toDto(row: TagRow): TagDto {
  return { id: row.id, name: row.name };
}

/** Runs a write and turns the case-insensitive name index violation into 409 `TAG_NAME_TAKEN`. */
async function nameTaken<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'tags_tenant_name') {
      throw conflict('TAG_NAME_TAKEN', 'A tag with this name already exists');
    }
    throw error;
  }
}

function requireScope(tx: TenantTransaction): TenantContext {
  const ctx = tenantScopeOf(tx);
  if (ctx === undefined) throw new Error('TagsService must run inside withTenant/withTenantReadOnly');
  return ctx;
}

class TagsRepository extends TenantRepository {
  list(tx: TenantTransaction, q?: string): Promise<TagRow[]> {
    let query = this.selectFrom(tx, 'tags').select(['id', 'name']);
    if (q !== undefined && q.length > 0) query = query.where('name', 'ilike', `%${escapeLike(q)}%`);
    return query.orderBy('name').orderBy('id').execute();
  }

  byId(tx: TenantTransaction, tagId: string): Promise<TagRow | undefined> {
    return this.selectFrom(tx, 'tags').select(['id', 'name']).where('id', '=', tagId).executeTakeFirst();
  }

  byIds(tx: TenantTransaction, tagIds: readonly string[]): Promise<TagRow[]> {
    if (tagIds.length === 0) return Promise.resolve([]);
    return this.selectFrom(tx, 'tags').select(['id', 'name']).where('id', 'in', tagIds as string[]).execute();
  }

  async insert(tx: TenantTransaction, row: { name: string }): Promise<string> {
    const inserted = await this.insertInto(tx, 'tags', row).returning('id').executeTakeFirstOrThrow();
    return inserted.id;
  }

  async update(tx: TenantTransaction, tagId: string, name: string): Promise<void> {
    await this.updateTable(tx, 'tags').set({ name }).where('id', '=', tagId).execute();
  }

  async delete(tx: TenantTransaction, tagId: string): Promise<void> {
    await this.deleteFrom(tx, 'tags').where('id', '=', tagId).execute();
  }

  async replaceTicketTags(tx: TenantTransaction, ticketId: string, tagIds: readonly string[]): Promise<void> {
    await this.deleteFrom(tx, 'ticket_tags').where('ticket_id', '=', ticketId).execute();
    if (tagIds.length > 0) {
      await this.insertInto(tx, 'ticket_tags', tagIds.map((tagId) => ({ ticket_id: ticketId, tag_id: tagId }))).execute();
    }
  }

  async replaceCustomerTags(tx: TenantTransaction, userId: string, tagIds: readonly string[]): Promise<void> {
    await this.deleteFrom(tx, 'customer_tags').where('user_id', '=', userId).execute();
    if (tagIds.length > 0) {
      await this.insertInto(tx, 'customer_tags', tagIds.map((tagId) => ({ user_id: userId, tag_id: tagId }))).execute();
    }
  }

  async tagsByTicketIds(tx: TenantTransaction, ticketIds: readonly string[]): Promise<Map<string, TagDto[]>> {
    if (ticketIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'ticket_tags')
      .innerJoin('tags', (join) => join.onRef('tags.tenant_id', '=', 'ticket_tags.tenant_id').onRef('tags.id', '=', 'ticket_tags.tag_id'))
      .select(['ticket_tags.ticket_id as ticketId', 'tags.id as id', 'tags.name as name'])
      .where('ticket_tags.ticket_id', 'in', ticketIds as string[])
      .orderBy('tags.name')
      .execute();
    return groupBy(rows, (row) => row.ticketId);
  }

  async tagsByUserIds(tx: TenantTransaction, userIds: readonly string[]): Promise<Map<string, TagDto[]>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.selectFrom(tx, 'customer_tags')
      .innerJoin('tags', (join) => join.onRef('tags.tenant_id', '=', 'customer_tags.tenant_id').onRef('tags.id', '=', 'customer_tags.tag_id'))
      .select(['customer_tags.user_id as userId', 'tags.id as id', 'tags.name as name'])
      .where('customer_tags.user_id', 'in', userIds as string[])
      .orderBy('tags.name')
      .execute();
    return groupBy(rows, (row) => row.userId);
  }
}

function groupBy<T extends { id: string; name: string }>(rows: (T & { [key: string]: unknown })[], keyOf: (row: T) => string): Map<string, TagDto[]> {
  const map = new Map<string, TagDto[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    const tag: TagDto = { id: row.id, name: row.name };
    if (list === undefined) map.set(key, [tag]);
    else list.push(tag);
  }
  return map;
}

/** Escapes `%`/`_`/`\` so the search term is matched literally under `ILIKE`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
