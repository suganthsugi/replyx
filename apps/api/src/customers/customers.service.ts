import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../authorization/policy.service.js';
import { UnitOfWork, type TenantTransaction } from '../platform-kernel/db/unit-of-work.js';
import { notFound } from '../platform-kernel/http/app-error.js';
import { TagsService } from '../tags/tags.service.js';
import { toTicketSummary, TicketRefsRepository } from '../tickets/ticket-dto.js';

import { CustomersRepository, type CustomerRow } from './customers.repository.js';

import type { CustomerProfileDto } from './customer-dto.js';
import type { TenantContext } from '../platform-kernel/db/tenant-context.js';
import type { TicketSummaryDto } from '../tickets/ticket-dto.js';
import type { TicketRow } from '../tickets/tickets.repository.js';

/**
 * Customer profiles (FR-069, contracts/tickets.yaml `/customers/{id}`).
 *
 * - `GET` shows contact details, tags, and open and closed tickets — the ticket lists are limited
 *   to what the caller may view (`ticketAccessFilter(ctx, 'view')`), never a 403 or partial 404.
 *   Summaries reuse the tickets module's `toTicketSummary`/`TicketRefsRepository` (ticket-dto.ts).
 * - `PATCH` changes name, phone, company and the customer's tag set (`user.edit`), via `TagsService`
 *   (`assertTagsExist` then `setCustomerTags`); an unknown tag id is 404 `TAG_NOT_FOUND`, the same
 *   shared behaviour the tickets module gets for ticket tags.
 */

export interface CustomerUpdateInput {
  name?: string;
  phone?: string;
  company?: string;
  tagIds?: readonly string[];
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly tags: TagsService,
  ) {}

  get(ctx: TenantContext, customerId: string): Promise<CustomerProfileDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => this.load(ctx, tx, customerId));
  }

  async update(ctx: TenantContext, customerId: string, input: CustomerUpdateInput): Promise<CustomerProfileDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new CustomersRepository(ctx);
      const before = await repo.profile(tx, customerId);
      if (before === undefined) throw notFound('customer');

      await repo.update(tx, customerId, { name: input.name, phone: input.phone, company: input.company });
      if (input.tagIds !== undefined) {
        await this.tags.assertTagsExist(tx, input.tagIds);
        await this.tags.setCustomerTags(tx, customerId, input.tagIds);
      }

      await this.audit.record(tx, {
        action: 'customer.updated',
        resourceType: 'user',
        resourceId: customerId,
        details: { fields: Object.keys(input) },
      });
      return this.load(ctx, tx, customerId);
    });
  }

  private async load(ctx: TenantContext, tx: TenantTransaction, customerId: string): Promise<CustomerProfileDto> {
    const repo = new CustomersRepository(ctx);
    const row = await repo.profile(tx, customerId);
    if (row === undefined) throw notFound('customer');

    const access = await this.policy.ticketAccessFilter(ctx, 'view');
    const [tagsByUser, tickets] = await Promise.all([this.tags.tagsByUserIds(tx, [customerId]), repo.ticketsOf(tx, customerId, access)]);
    const summaries = await this.toSummaries(ctx, tx, tickets);

    return {
      ...this.toDto(row),
      tags: tagsByUser.get(customerId) ?? [],
      openTickets: summaries.filter((ticket) => ticket.state !== 'closed'),
      closedTickets: summaries.filter((ticket) => ticket.state === 'closed'),
    };
  }

  private async toSummaries(ctx: TenantContext, tx: TenantTransaction, rows: TicketRow[]): Promise<TicketSummaryDto[]> {
    const refs = await new TicketRefsRepository(ctx).load(tx, rows);
    const tagsByTicket = await this.tags.tagsByTicketIds(tx, rows.map((row) => row.id));
    return rows.map((row) => ({ ...toTicketSummary(row, refs), tags: tagsByTicket.get(row.id) ?? [] }));
  }

  private toDto(row: CustomerRow): Omit<CustomerProfileDto, 'tags' | 'openTickets' | 'closedTickets'> {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      status: row.status,
      phone: row.phone,
      company: row.company,
      createdAt: row.created_at.toISOString(),
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
    };
  }
}
