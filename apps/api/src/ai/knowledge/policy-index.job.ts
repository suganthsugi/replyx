import { Inject, Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';

import { FILE_STORAGE, type FileStorage } from '../../attachments/storage/file-storage.js';
import { Clock } from '../../platform-kernel/clock.js';
import { TenantContext } from '../../platform-kernel/db/tenant-context.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { IdempotentHandler, type DomainEvent } from '../../platform-kernel/jobs/idempotent-handler.js';
import { JobProcessor } from '../../platform-kernel/jobs/job-processor.js';
import { DEFAULT_ATTEMPTS, QueueRegistry } from '../../platform-kernel/jobs/queues.js';
import { runWithLogContext } from '../../platform-kernel/observability/logger.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { AiAudience } from '../ai-audience.js';
import { EMBEDDING_MODEL } from '../providers/catalog.js';
import { AI_PROVIDER, ProviderError, type AiProvider } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';
import { AiStatus } from '../settings/ai-status.js';

import { chunkPolicyText, MAX_CHUNKS, type PolicyChunk } from './policy-chunker.js';
import { PolicyIndexRepository, type EmbeddedChunk, type IndexableVersion } from './policy-index.repository.js';
import { extractPolicyText, fileKindOf, MAX_POLICY_CHARS } from './policy-text.js';

import type { PolicyVersionError, PolicyVersionStatus } from '../../platform-kernel/db/tables/ai.js';
import type { DomainEventType } from '../../platform-kernel/outbox/event-types.js';
import type { Readable } from 'node:stream';

/** The job's name and queue (research R4/R6); its id is `index.{versionId}`. */
export const AI_INDEX_JOB = 'ai-index';
export const EMBED_BATCH = 64;
/** Wait for the malware scan: every 15 s for up to an hour, then the file counts as not cleared. */
const SCAN_POLL_MS = 15_000;
const MAX_SCAN_WAITS = 240;
/** Provider errors are retried with a longer back-off than the default (rate limits, outages). */
const INDEX_ATTEMPTS = DEFAULT_ATTEMPTS;
const INDEX_BACKOFF_MS = 10_000;

export interface AiIndexJobData {
  tenantId: string;
  documentId: string;
  versionId: string;
  /** Scan polls so far. */
  waits?: number;
}

export function indexJobId(versionId: string): string {
  // BullMQ rejects `:` in custom ids (one `:` is not the repeatable-job form), so `.` like `eventJobId`.
  return `index.${versionId}`;
}

type Handled = Extract<DomainEventType, 'ai.policy_version_created'>;

/**
 * Turns `ai.policy_version_created` into the `ai-index` job. The indexer itself must not run in the
 * consumer: that would hold a database transaction open across the embedding calls.
 */
@Injectable()
export class AiPolicyIndexEnqueuer extends IdempotentHandler<Handled> {
  readonly consumer = 'ai-policy-index-enqueue';
  readonly queue = 'ai' as const;
  readonly eventTypes: readonly Handled[] = ['ai.policy_version_created'];

  constructor(
    unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
  ) {
    super(unitOfWork);
  }

  protected async handle(_tx: TenantTransaction, event: DomainEvent<Handled>): Promise<void> {
    const data: AiIndexJobData = { tenantId: event.tenantId, documentId: event.payload.documentId, versionId: event.payload.versionId };
    // Idempotent by job id: a retried event adds nothing.
    await this.queues.get('ai').add(AI_INDEX_JOB, data, {
      jobId: indexJobId(data.versionId),
      attempts: INDEX_ATTEMPTS,
      backoff: { type: 'exponential', delay: INDEX_BACKOFF_MS },
    });
  }
}

export type IndexOutcome = 'active' | 'failed' | 'superseded' | 'skipped';

/** A result that ends the job with the version marked `failed`. */
class IndexFailure extends Error {
  constructor(readonly code: PolicyVersionError) {
    super(`Policy version could not be indexed: ${code}`);
  }
}

function isMissing(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound';
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as string));
  return Buffer.concat(parts);
}

/** Newer by creation time, then id (ids are UUIDv7, so they follow creation order). */
function isNewer(a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }): boolean {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  return diff === 0 ? a.id > b.id : diff > 0;
}

/**
 * The `ai-index` job (specs/002-ai-assist research R3/R4): reads a policy version, chunks it,
 * embeds the chunks with the tenant's own key and swaps it in as the document's active version.
 *
 * No database transaction is open while the provider is called: the version is read first, the
 * embeddings are fetched, then one transaction locks the document and does the swap. The job is
 * safe to run twice: a version that is no longer `processing` is left alone. While the attachment
 * scan is pending the job moves itself to the delayed set rather than polling.
 */
@Injectable()
export class AiIndexJob extends JobProcessor<AiIndexJobData> {
  readonly queue = 'ai' as const;
  readonly jobName = AI_INDEX_JOB;
  private readonly logger = new Logger('AiIndexJob');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly audience: AiAudience,
    private readonly status: AiStatus,
    private readonly runs: AiRunsRecorder,
    private readonly clock: Clock,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {
    super();
  }

  process(data: AiIndexJobData, job: Job<AiIndexJobData>): Promise<IndexOutcome> {
    const ctx = TenantContext.create({ tenantId: data.tenantId, actor: { kind: 'system' }, requestId: `job:${job.id ?? data.versionId}`.slice(0, 128) });
    return runWithLogContext({ tenantId: ctx.tenantId, jobId: job.id }, () => this.run(ctx, data, job));
  }

  private async run(ctx: TenantContext, data: AiIndexJobData, job: Job<AiIndexJobData>): Promise<IndexOutcome> {
    const version = await this.unitOfWork.withTenantReadOnly(ctx, (tx) => new PolicyIndexRepository(ctx).findVersion(tx, data.versionId));
    // Gone, finished by an earlier attempt, or its document was deleted meanwhile: nothing to do.
    if (version === undefined || version.status !== 'processing' || version.documentDeleted) return 'skipped';

    try {
      const prepared = await this.prepare(ctx, version, job);
      if (prepared === 'superseded') return await this.supersede(ctx, version);
      const outcome = await this.embedAndSwap(ctx, version, prepared.chunks, prepared.chars);
      this.logger.log(`Indexed policy version ${version.id}: ${outcome}`);
      return outcome;
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      if (error instanceof IndexFailure) {
        await this.fail(ctx, version, error.code);
        return 'failed';
      }
      // Anything else is retried; the last attempt marks the version failed so it never stays "processing".
      if (this.isLastAttempt(job)) await this.fail(ctx, version, 'embedding_failed');
      throw error;
    }
  }

  private isLastAttempt(job: Job<AiIndexJobData>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? DEFAULT_ATTEMPTS);
  }

  /** The text of the version as passages, or `superseded` when a newer version is already active. */
  private async prepare(ctx: TenantContext, version: IndexableVersion, job: Job<AiIndexJobData>): Promise<{ chunks: PolicyChunk[]; chars: number } | 'superseded'> {
    const newer = await this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const active = await new PolicyIndexRepository(ctx).activeVersion(tx, version.documentId);
      return active !== undefined && isNewer(active, version);
    });
    if (newer) return 'superseded';

    const text = version.source === 'text' ? (version.body ?? '') : await this.fileText(ctx, version, job);
    if (text.trim().length === 0) throw new IndexFailure('no_extractable_text');
    if (text.length > MAX_POLICY_CHARS) throw new IndexFailure('too_large');
    const chunks = chunkPolicyText(text);
    if (chunks.length === 0) throw new IndexFailure('no_extractable_text');
    if (chunks.length > MAX_CHUNKS) throw new IndexFailure('too_large');
    return { chunks, chars: text.length };
  }

  private async fileText(ctx: TenantContext, version: IndexableVersion, job: Job<AiIndexJobData>): Promise<string> {
    const file = version.file;
    if (file === null) throw new IndexFailure('no_extractable_text');
    if (file.scanStatus === 'blocked') throw new IndexFailure('blocked_by_scan');
    if (file.scanStatus === 'pending') {
      const waits = job.data.waits ?? 0;
      if (waits >= MAX_SCAN_WAITS) throw new IndexFailure('blocked_by_scan');
      await job.updateData({ ...job.data, waits: waits + 1 });
      // BullMQ timers run on wall time, not the business clock.
      await job.moveToDelayed(Date.now() + SCAN_POLL_MS, job.token);
      throw new DelayedError();
    }
    const kind = fileKindOf(file.contentType);
    if (kind === undefined) throw new IndexFailure('unsupported_type');

    let bytes: Buffer;
    try {
      bytes = await readAll(await this.storage.read({ tenantId: ctx.tenantId, attachmentId: file.attachmentId, area: 'files' }));
    } catch (error) {
      // A clean file always sits in `files`; a missing one is a storage problem worth a retry.
      if (isMissing(error)) throw new Error(`Policy file ${file.attachmentId} is missing from storage`);
      throw error;
    }
    return extractPolicyText(kind, bytes);
  }

  /** Embeds in batches of 64 with the tenant's key, then swaps the version in. */
  private async embedAndSwap(ctx: TenantContext, version: IndexableVersion, chunks: PolicyChunk[], chars: number): Promise<IndexOutcome> {
    const settings = await this.status.settings(ctx);
    const credentials = this.status.credentials(settings);
    // A paused tenant's key is known to be bad (or out of credit): no call is made until it is fixed.
    if (credentials === undefined || settings.pausedReason !== null) throw new IndexFailure('embedding_failed');

    const embedded: EmbeddedChunk[] = [];
    for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
      const batch = chunks.slice(start, start + EMBED_BATCH);
      let result;
      try {
        result = await this.runs.track(ctx, { purpose: 'embedding', model: EMBEDDING_MODEL.id }, () =>
          this.provider.embed(credentials, { model: EMBEDDING_MODEL.id, inputs: batch.map(embeddingInput) }),
        );
      } catch (error) {
        if (error instanceof ProviderError && error.pausesTenant) {
          await this.status.pauseFor(ctx, error);
          throw new IndexFailure('embedding_failed');
        }
        throw error;
      }
      if (result.vectors.length !== batch.length || result.vectors.some((vector) => vector.length !== EMBEDDING_MODEL.dimensions)) {
        throw new Error('The embedding provider returned an unexpected number of vectors or dimensions');
      }
      batch.forEach((chunk, index) => embedded.push({ ...chunk, embedding: result.vectors[index]!, model: result.model }));
    }

    return this.unitOfWork.withTenant(ctx, async (tx): Promise<IndexOutcome> => {
      const repo = new PolicyIndexRepository(ctx);
      const document = await repo.lockDocument(tx, version.documentId);
      if (document === undefined || document.deleted) return 'skipped';
      if ((await repo.lockVersionStatus(tx, version.id)) !== 'processing') return 'skipped';
      const active = await repo.activeVersion(tx, version.documentId);
      if (active !== undefined && isNewer(active, version)) {
        await repo.markSuperseded(tx, version.id, this.clock.now());
        await this.announce(tx, ctx, version, 'superseded');
        return 'superseded';
      }
      await repo.activate(tx, { documentId: version.documentId, versionId: version.id, chunks: embedded, extractedChars: chars, now: this.clock.now() });
      await this.announce(tx, ctx, version, 'active');
      return 'active';
    });
  }

  /** A newer version is already live: this one is replaced without ever being active. */
  private async supersede(ctx: TenantContext, version: IndexableVersion): Promise<IndexOutcome> {
    return this.unitOfWork.withTenant(ctx, async (tx): Promise<IndexOutcome> => {
      const repo = new PolicyIndexRepository(ctx);
      const document = await repo.lockDocument(tx, version.documentId);
      if (document === undefined || document.deleted) return 'skipped';
      if ((await repo.lockVersionStatus(tx, version.id)) !== 'processing') return 'skipped';
      await repo.markSuperseded(tx, version.id, this.clock.now());
      await this.announce(tx, ctx, version, 'superseded');
      return 'superseded';
    });
  }

  private async fail(ctx: TenantContext, version: IndexableVersion, error: PolicyVersionError): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new PolicyIndexRepository(ctx);
      const document = await repo.lockDocument(tx, version.documentId);
      if (document === undefined || document.deleted) return;
      if ((await repo.lockVersionStatus(tx, version.id)) !== 'processing') return;
      await repo.markFailed(tx, version.id, error, this.clock.now());
      await this.announce(tx, ctx, version, 'failed');
    });
  }

  /** Tells the admins' Policies screen; written in the same transaction as the change. */
  private async announce(tx: TenantTransaction, ctx: TenantContext, version: IndexableVersion, status: PolicyVersionStatus): Promise<void> {
    await this.outbox.append(tx, {
      type: 'ai.policy_version_updated',
      actor: { kind: 'system' },
      payload: { documentId: version.documentId, versionId: version.id, status },
      streams: await this.audience.streamsFor(tx, ctx, 'ai_knowledge.manage'),
    });
  }
}

/** The heading is part of what the passage is about, as in the stored search vector. */
function embeddingInput(chunk: PolicyChunk): string {
  return chunk.heading === null ? chunk.content : `${chunk.heading}\n\n${chunk.content}`;
}
