import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { FILE_STORAGE, type FileStorage } from '../../../src/attachments/storage/file-storage.js';
import { TenantContext } from '../../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../../src/platform-kernel/db/unit-of-work.js';
import { uuidv7 } from '../../../src/platform-kernel/ids.js';
import { PURGE_BATCH_SIZE, RetentionService } from '../../../src/tenancy/retention/retention.service.js';
import { getTestApp, service } from '../../support/app.js';
import { createTenant, createTicket, createUser, type TestTenant, type TestTicket, type TestUser } from '../../support/factories.js';
import { asUser } from '../../support/http.js';

/**
 * The retention purge end to end (T196, FR-005a, research D18): the confirmation flow of
 * `PATCH /settings`, which tickets are purged, files, tombstone links, the audit entry, tenant
 * isolation and the customer's thread afterwards. Smoke coverage is in retention-smoke.test.ts.
 */

const YEAR_MS = 365 * 24 * 3_600_000;

interface Failure {
  error: { code: string; details?: { path: string; issue: string; purgeCount?: number }[] };
}

class Probe extends TenantRepository {
  async ticketIds(tx: TenantTransaction): Promise<string[]> {
    return (await this.selectFrom(tx, 'tickets').select('tickets.id').execute()).map((row) => row.id);
  }

  async setClosedAt(tx: TenantTransaction, ticketId: string, closedAt: Date): Promise<void> {
    await this.updateTable(tx, 'tickets')
      .set({ closed_at: closedAt, resolved_at: closedAt })
      .where('tickets.id', '=', ticketId)
      .execute();
  }

  async setRetention(tx: TenantTransaction, period: string): Promise<void> {
    await this.updateTable(tx, 'tenant_settings').set({ retention_period: period }).execute();
  }

  async messageIds(tx: TenantTransaction, ticketId: string): Promise<string[]> {
    const rows = await this.selectFrom(tx, 'ticket_messages').select('ticket_messages.id').where('ticket_messages.ticket_id', '=', ticketId).execute();
    return rows.map((row) => row.id);
  }

  async insertAttachment(tx: TenantTransaction, id: string, messageId: string, uploadedBy: string): Promise<void> {
    await this.insertInto(tx, 'attachments', {
      id,
      message_id: messageId,
      uploaded_by: uploadedBy,
      file_name: 'a.txt',
      content_type: 'text/plain',
      size_bytes: 3,
      storage_key: `${this.ctx.tenantId}/files/${id}`,
    }).execute();
  }

  async attachmentCount(tx: TenantTransaction): Promise<number> {
    return (await this.selectFrom(tx, 'attachments').select('attachments.id').execute()).length;
  }

  async insertLink(tx: TenantTransaction, from: string, to: string, kind: 'follow_up_of' | 'related'): Promise<void> {
    await this.insertInto(tx, 'ticket_links', { from_ticket_id: from, to_ticket_id: to, kind }).execute();
  }

  async linksFrom(tx: TenantTransaction, from: string) {
    return this.selectFrom(tx, 'ticket_links')
      .select(['ticket_links.kind', 'ticket_links.to_ticket_id', 'ticket_links.removed_reason'])
      .where('ticket_links.from_ticket_id', '=', from)
      .execute();
  }

  async linkCount(tx: TenantTransaction): Promise<number> {
    return (await this.selectFrom(tx, 'ticket_links').select('ticket_links.id').execute()).length;
  }

  async purgeAudit(tx: TenantTransaction) {
    return this.selectFrom(tx, 'audit_logs').select(['details', 'actor_kind']).where('action', '=', 'retention.purged').execute();
  }
}

async function probe<T>(tenant: TestTenant, fn: (repo: Probe, tx: TenantTransaction) => Promise<T>): Promise<T> {
  const ctx = TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'retention-full' });
  return (await service(UnitOfWork)).withTenant(ctx, (tx) => fn(new Probe(ctx), tx));
}

const setClosedAt = (tenant: TestTenant, ticket: TestTicket, closedAt: Date) => probe(tenant, (repo, tx) => repo.setClosedAt(tx, ticket.id, closedAt));
const setRetention = (tenant: TestTenant, period: string) => probe(tenant, (repo, tx) => repo.setRetention(tx, period));
const remaining = (tenant: TestTenant) => probe(tenant, (repo, tx) => repo.ticketIds(tx));
const purge = async (tenant: TestTenant) => (await service(RetentionService)).purgeTenant(tenant.id);

async function now(): Promise<Date> {
  return (await getTestApp()).clock.now();
}

async function longAgo(): Promise<Date> {
  return new Date((await now()).getTime() - 3 * YEAR_MS);
}

async function setup(): Promise<{ tenant: TestTenant; admin: TestUser; customer: TestUser }> {
  const tenant = await createTenant();
  const [admin, customer] = await Promise.all([createUser(tenant, { roles: ['admin'] }), createUser(tenant, { roles: ['customer'] })]);
  return { tenant, admin, customer };
}

beforeAll(async () => {
  await getTestApp();
});

describe('the confirmation flow of PATCH /settings', () => {
  it('answers a stale count with a fresh 409 carrying the new purgeCount', async () => {
    const { tenant, admin, customer } = await setup();
    const long = await longAgo();
    await Promise.all([1, 2].map(() => createTicket(tenant, { customer, state: 'closed', now: long })));

    const first = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y' });
    expect(first.status).toBe(409);
    expect((first.body as Failure).error.details?.[0]?.purgeCount).toBe(2);

    // Another ticket becomes purgeable between the preview and the confirmation.
    await createTicket(tenant, { customer, state: 'closed', now: long });
    const stale = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y', confirmPurgeCount: 2 });
    expect(stale.status).toBe(409);
    expect((stale.body as Failure).error.code).toBe('RETENTION_CONFIRMATION_REQUIRED');
    expect((stale.body as Failure).error.details).toEqual([{ path: 'confirmPurgeCount', issue: 'confirmation_required', purgeCount: 3 }]);
    expect((await asUser(admin).get('/settings')).body).toMatchObject({ retentionPeriod: 'forever' });

    expect((await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y', confirmPurgeCount: 3 })).status).toBe(200);
  });

  it('needs no confirmation when shortening would purge nothing, or when lengthening', async () => {
    const { tenant, admin, customer } = await setup();
    const long = await longAgo();
    await createTicket(tenant, { customer, state: 'closed', messages: [{ body: 'recent' }] });
    await createTicket(tenant, { customer, state: 'open', now: long });

    // Shortening, but N = 0: a recent closed and an old open ticket are not purgeable.
    expect((await asUser(admin).patch('/settings', { retentionPeriod: 'P3Y' })).status).toBe(200);
    const none = await asUser(admin).patch('/settings', { retentionPeriod: 'P1Y' });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ retentionPeriod: 'P1Y' });

    // Lengthening with a purgeable ticket present.
    await createTicket(tenant, { customer, state: 'closed', now: long });
    const longer = await asUser(admin).patch('/settings', { retentionPeriod: 'P7Y' });
    expect(longer.status).toBe(200);
    expect(longer.body).toMatchObject({ retentionPeriod: 'P7Y' });
    expect(await remaining(tenant)).toHaveLength(3);
  });
});

describe('which tickets are purged', () => {
  it('purges a ticket closed just past the cutoff and keeps one closed exactly at it', async () => {
    const { tenant, customer } = await setup();
    const cutoff = await now();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const past = await createTicket(tenant, { customer, state: 'closed' });
    const exact = await createTicket(tenant, { customer, state: 'closed' });
    const inside = await createTicket(tenant, { customer, state: 'closed' });
    await setClosedAt(tenant, past, new Date(cutoff.getTime() - 1));
    await setClosedAt(tenant, exact, cutoff);
    await setClosedAt(tenant, inside, new Date(cutoff.getTime() + 1));
    await setRetention(tenant, 'P1Y');

    expect(await purge(tenant)).toMatchObject({ tickets: 1 });
    expect((await remaining(tenant)).sort()).toEqual([exact.id, inside.id].sort());
  });

  it('keeps open, pending and resolved tickets older than the period', async () => {
    const { tenant, customer } = await setup();
    const long = await longAgo();
    const kept = await Promise.all(
      (['new', 'open', 'pending_reminder', 'pending_close', 'resolved'] as const).map((state) => createTicket(tenant, { customer, state, now: long })),
    );
    const old = await createTicket(tenant, { customer, state: 'closed', now: long });
    await setRetention(tenant, 'P1Y');

    expect(await purge(tenant)).toMatchObject({ tickets: 1 });
    const ids = await remaining(tenant);
    expect(ids.sort()).toEqual(kept.map((ticket) => ticket.id).sort());
    expect(ids).not.toContain(old.id);
  });

  it('purges more than 500 across batches and writes one audit entry with counts only', async () => {
    const { tenant, customer } = await setup();
    const long = await longAgo();
    const total = PURGE_BATCH_SIZE + 3;
    for (let start = 0; start < total; start += 25) {
      await Promise.all(
        Array.from({ length: Math.min(25, total - start) }, (_, index) =>
          createTicket(tenant, { customer, state: 'closed', now: long, messages: [{ body: `secret-body-${start + index}` }] }),
        ),
      );
    }
    const keeper = await createTicket(tenant, { customer, state: 'open', now: long });
    await setRetention(tenant, 'P1Y');

    expect(await purge(tenant)).toMatchObject({ tickets: total, messages: total });
    expect(await remaining(tenant)).toEqual([keeper.id]);

    const entries = await probe(tenant, (repo, tx) => repo.purgeAudit(tx));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor_kind).toBe('system');
    expect(entries[0]?.details).toMatchObject({ retentionPeriod: 'P1Y', ticketCount: total, messageCount: total });
    expect(JSON.stringify(entries[0]?.details)).not.toMatch(/secret-body/);

    // A second run finds nothing and adds no second entry.
    expect(await purge(tenant)).toMatchObject({ tickets: 0 });
    expect(await probe(tenant, (repo, tx) => repo.purgeAudit(tx))).toHaveLength(1);
  }, 180_000);
});

describe('attachments and links', () => {
  it('removes the attachment files from the storage directory and keeps other tickets files', async () => {
    const { tenant, customer } = await setup();
    const storage = (await getTestApp()).app.get<FileStorage>(FILE_STORAGE);
    const long = await longAgo();
    const old = await createTicket(tenant, { customer, state: 'closed', now: long, messages: [{ body: 'with file' }] });
    const kept = await createTicket(tenant, { customer, state: 'open', now: long, messages: [{ body: 'keeps file' }] });

    const [oldFile, keptFile] = [uuidv7(), uuidv7()];
    for (const [ticket, id] of [
      [old, oldFile],
      [kept, keptFile],
    ] as const) {
      const [messageId] = await probe(tenant, (repo, tx) => repo.messageIds(tx, ticket.id));
      await probe(tenant, (repo, tx) => repo.insertAttachment(tx, id, messageId ?? '', customer.id));
      await storage.put({ tenantId: tenant.id, attachmentId: id, area: 'files' }, Buffer.from('abc'));
    }
    const path = (id: string) => join(process.env.FILES_DIR ?? '', tenant.id, 'files', id);
    expect(existsSync(path(oldFile))).toBe(true);
    await setRetention(tenant, 'P1Y');

    expect(await purge(tenant)).toMatchObject({ tickets: 1, attachments: 1, files: 1 });
    expect(existsSync(path(oldFile))).toBe(false);
    expect(existsSync(path(keptFile))).toBe(true);
    expect(await probe(tenant, (repo, tx) => repo.attachmentCount(tx))).toBe(1);
  });

  it('turns a survivor follow-up link into a tombstone and drops the purged tickets own links', async () => {
    const { tenant, customer } = await setup();
    const old = await createTicket(tenant, { customer, state: 'closed', now: await longAgo() });
    const followUp = await createTicket(tenant, { customer, state: 'open' });
    await probe(tenant, async (repo, tx) => {
      await repo.insertLink(tx, followUp.id, old.id, 'follow_up_of');
      await repo.insertLink(tx, old.id, followUp.id, 'related');
    });
    await setRetention(tenant, 'P1Y');

    expect(await purge(tenant)).toMatchObject({ tickets: 1, links: 2 });
    expect(await probe(tenant, (repo, tx) => repo.linksFrom(tx, followUp.id))).toEqual([
      { kind: 'follow_up_of', to_ticket_id: null, removed_reason: 'retention' },
    ]);
    expect(await probe(tenant, (repo, tx) => repo.linkCount(tx))).toBe(1);
  });
});

describe('tenant isolation', () => {
  it('leaves another tenant with old closed tickets untouched', async () => {
    const a = await setup();
    const b = await setup();
    const long = await longAgo();
    const oldA = await createTicket(a.tenant, { customer: a.customer, state: 'closed', now: long, messages: [{ body: 'a' }] });
    const oldB = await createTicket(b.tenant, { customer: b.customer, state: 'closed', now: long, messages: [{ body: 'b' }] });
    await Promise.all([setRetention(a.tenant, 'P1Y'), setRetention(b.tenant, 'P1Y')]);

    expect(await purge(a.tenant)).toMatchObject({ tickets: 1 });
    expect(await remaining(a.tenant)).not.toContain(oldA.id);
    expect(await remaining(b.tenant)).toEqual([oldB.id]);
    expect(await probe(b.tenant, (repo, tx) => repo.purgeAudit(tx))).toHaveLength(0);
    expect(await probe(a.tenant, (repo, tx) => repo.purgeAudit(tx))).toHaveLength(1);
  });
});

describe('a customer writing after a purge', () => {
  it('gets a new ticket with no follow-up link, and the thread no longer shows purged messages', async () => {
    const { tenant, customer } = await setup();
    const old = await createTicket(tenant, { customer, state: 'closed', now: await longAgo(), messages: [{ body: 'old question' }] });
    await setRetention(tenant, 'P1Y');

    interface Thread {
      items: { type: string; message?: { body: string } }[];
    }
    const before = (await asUser(customer).get('/customer/conversation')).body as Thread;
    expect(JSON.stringify(before)).toContain('old question');

    expect(await purge(tenant)).toMatchObject({ tickets: 1 });
    const emptied = (await asUser(customer).get('/customer/conversation')).body as Thread;
    expect(JSON.stringify(emptied)).not.toContain('old question');
    expect(emptied.items).toHaveLength(0);

    const sent = await asUser(customer).post('/customer/messages', { body: 'new question', clientMessageId: uuidv7() });
    expect(sent.status).toBe(201);

    const ids = await remaining(tenant);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(old.id);
    expect(await probe(tenant, (repo, tx) => repo.linksFrom(tx, ids[0] ?? ''))).toEqual([]);
    expect(await probe(tenant, (repo, tx) => repo.linkCount(tx))).toBe(0);
    const thread = (await asUser(customer).get('/customer/conversation')).body as Thread;
    expect(thread.items.map((item) => item.message?.body)).toEqual(['new question']);
  });
});
