import { sql } from 'kysely';
import supertest from 'supertest';

import { AiAudience } from '../../src/ai/ai-audience.js';
import { AiIndexJob, type AiIndexJobData, type IndexOutcome } from '../../src/ai/knowledge/policy-index.job.js';
import { AI_PROVIDER, type AiProvider } from '../../src/ai/providers/ports.js';
import { AiRunsRecorder } from '../../src/ai/runs/ai-runs.recorder.js';
import { AiStatus } from '../../src/ai/settings/ai-status.js';
import { API_PREFIX } from '../../src/app.setup.js';
import { AttachmentScanConsumer, type MalwareScanner, type ScanVerdict } from '../../src/attachments/scan.job.js';
import { FILE_STORAGE, type FileStorage } from '../../src/attachments/storage/file-storage.js';
import { Clock } from '../../src/platform-kernel/clock.js';
import { TenantContext } from '../../src/platform-kernel/db/tenant-context.js';
import { TenantRepository } from '../../src/platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../src/platform-kernel/db/unit-of-work.js';
import { OutboxService } from '../../src/platform-kernel/outbox/outbox.service.js';

import { getTestApp, service } from './app.js';
import { asUser } from './http.js';

import type { TestTenant, TestUser } from './factories.js';
import type { Job } from 'bullmq';
import type { Readable } from 'node:stream';

/**
 * Helpers for the policy-document tests (specs/002-ai-assist T016): upload a file the way the
 * admin screen does, give it a scan verdict, and run the `ai-index` job directly with a stand-in
 * for the BullMQ job, so the 15 s scan wait and the retry count are in the test's hands.
 */

export const contextOf = (tenant: { id: string }) => TenantContext.create({ tenantId: tenant.id, actor: { kind: 'system' }, requestId: 'policy-test' });

export async function createPolicy(admin: TestUser, body: object): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const response = await asUser(admin).post('/ai/policies', body);
  return { id: (response.body as { id?: string }).id ?? '', status: response.status, body: response.body as Record<string, unknown> };
}

/** The newest version of a document, as the admin screen lists it. */
export async function newestVersionId(admin: TestUser, documentId: string): Promise<string> {
  const detail = (await asUser(admin).get(`/ai/policies/${documentId}`)).body as { versions: { id: string }[] };
  const id = detail.versions[0]?.id;
  if (id === undefined) throw new Error(`Policy ${documentId} has no versions`);
  return id;
}

/** POST /attachments as , whatever the answer. */
export async function uploadFileRaw(user: TestUser, buffer: Buffer, fileName: string): Promise<supertest.Response> {
  const { app } = await getTestApp();
  return supertest(app.getHttpServer())
    .post(`/${API_PREFIX}/attachments`)
    .set('Host', user.tenant.host)
    .set('Cookie', [`rx_session=${user.sessionToken}`, `rx_csrf=${user.csrfToken}`].join('; '))
    .set('X-CSRF-Token', user.csrfToken)
    .attach('file', buffer, fileName);
}

export async function uploadFile(user: TestUser, buffer: Buffer, fileName: string): Promise<string> {
  const response = await uploadFileRaw(user, buffer, fileName);
  if (response.status !== 201) throw new Error(`Upload failed: ${response.status} ${JSON.stringify(response.body)}`);
  return (response.body as { id: string }).id;
}

class StubScanner implements MalwareScanner {
  readonly name = 'stub';
  constructor(private readonly verdict: ScanVerdict) {}
  async scan(file: Readable): Promise<ScanVerdict> {
    for await (const chunk of file) void chunk;
    return this.verdict;
  }
}

class UploadEvents extends TenantRepository {
  find(tx: TenantTransaction, attachmentId: string) {
    return this.selectFrom(tx, 'outbox_events')
      .select('id')
      .where('type', '=', 'attachment.uploaded')
      .where(sql<boolean>`payload ->> 'attachmentId' = ${attachmentId}`)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
  }
}

/** Gives an uploaded file its scan verdict (moving a clean file to `files`), without a worker. */
export async function scanFile(tenant: TestTenant, attachmentId: string, verdict: ScanVerdict): Promise<void> {
  const { app, clock } = await getTestApp();
  const unitOfWork = await service(UnitOfWork);
  const consumer = new AttachmentScanConsumer(unitOfWork, await service(OutboxService), clock, app.get<FileStorage>(FILE_STORAGE), new StubScanner(verdict));
  const ctx = contextOf(tenant);
  const { id: eventId } = await unitOfWork.withTenant(ctx, (tx) => new UploadEvents(ctx).find(tx, attachmentId));
  const result = await consumer.process({ tenantId: tenant.id, eventId }, 'test-job');
  if (result !== 'handled') throw new Error(`Scan job did not run: ${result}`);
}

export interface RunOptions {
  /** Failed attempts so far; the job marks the version failed on its last one. */
  attemptsMade?: number;
  waits?: number;
}

export interface RunResult {
  outcome: IndexOutcome | 'delayed' | { threw: string };
  /** Set when the job moved itself to the delayed set. */
  delayedUntil?: number;
  data: AiIndexJobData;
}

/** Runs `ai-index` for one version the way the worker would, with a stand-in BullMQ job. */
export async function runIndex(tenant: TestTenant, documentId: string, versionId: string, options: RunOptions = {}): Promise<RunResult> {
  const { app } = await getTestApp();
  const job = new AiIndexJob(
    await service(UnitOfWork),
    await service(OutboxService),
    await service(AiAudience),
    await service(AiStatus),
    await service(AiRunsRecorder),
    await service(Clock),
    app.get<AiProvider>(AI_PROVIDER),
    app.get<FileStorage>(FILE_STORAGE),
  );
  const result: RunResult = {
    outcome: 'skipped',
    data: { tenantId: tenant.id, documentId, versionId, ...(options.waits === undefined ? {} : { waits: options.waits }) },
  };
  const fake = {
    id: `index.${versionId}`,
    token: 'test-token',
    opts: { attempts: 3 },
    attemptsMade: options.attemptsMade ?? 0,
    get data() {
      return result.data;
    },
    updateData(data: AiIndexJobData) {
      result.data = data;
      return Promise.resolve();
    },
    moveToDelayed(timestamp: number) {
      result.delayedUntil = timestamp;
      return Promise.resolve();
    },
  } as unknown as Job<AiIndexJobData>;
  try {
    result.outcome = await job.process(result.data, fake);
  } catch (error) {
    const name = (error as Error).constructor.name;
    result.outcome = name === 'DelayedError' ? 'delayed' : { threw: (error as Error).message };
  }
  return result;
}

export async function versionRow(tenant: TestTenant, versionId: string) {
  return (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
    tx.selectFrom('ai_policy_versions').select(['status', 'error']).where('tenant_id', '=', tenant.id).where('id', '=', versionId).executeTakeFirstOrThrow(),
  );
}

export async function chunkCount(tenant: TestTenant, documentId: string): Promise<number> {
  const rows = await (await service(UnitOfWork)).withTenantReadOnly(contextOf(tenant), (tx) =>
    tx.selectFrom('ai_policy_chunks').select('id').where('tenant_id', '=', tenant.id).where('document_id', '=', documentId).execute(),
  );
  return rows.length;
}
