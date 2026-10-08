import { extname } from 'node:path';

import { Injectable } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { Clock } from '../../platform-kernel/clock.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { conflict, notFound, validationFailed } from '../../platform-kernel/http/app-error.js';
import { OutboxService } from '../../platform-kernel/outbox/outbox.service.js';
import { AiAudience } from '../ai-audience.js';

import { AiPoliciesRepository, type PolicyDocumentRow, type PolicyVersionRow } from './ai-policies.repository.js';

import type { PolicyDocumentInput, PolicyVersionInput } from './ai-policies.input.js';
import type { PolicyVersionError, PolicyVersionSource, PolicyVersionStatus } from '../../platform-kernel/db/tables/ai.js';
import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

export type PolicyStatus = 'processing' | 'ready' | 'failed';

export interface PolicyDocumentDto {
  id: string;
  title: string;
  status: PolicyStatus;
  error: PolicyVersionError | null;
  source: PolicyVersionSource | null;
  fileName: string | null;
  activeSince: string | null;
  updatedAt: string;
}

export interface PolicyVersionDto {
  id: string;
  status: PolicyVersionStatus;
  source: PolicyVersionSource;
  error: PolicyVersionError | null;
  createdAt: string;
  createdBy?: { id: string; name: string; avatarUrl: null };
}

export interface PolicyDocumentDetailDto extends PolicyDocumentDto {
  text: string | null;
  versions: PolicyVersionDto[];
}

/** Versions listed on a document (contracts/ai.yaml `PolicyDocumentDetail`, `maxItems: 10`). */
const RECENT_VERSIONS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** What the indexer can read: `.txt` and `.md` as they are, PDF through text extraction. */
const FILE_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
};

const TITLE_INDEX = 'ai_policy_documents_tenant_title';

/** A version's source once the input has been checked. */
type VersionSource = { source: 'text'; body: string; attachmentId: null; fileName: null } | { source: 'file'; body: null; attachmentId: string; fileName: string };

function titleTaken() {
  return conflict('POLICY_TITLE_TAKEN', 'A policy with this title already exists');
}

function isTitleViolation(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === TITLE_INDEX;
}

export function toVersionDto(row: PolicyVersionRow): PolicyVersionDto {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    // The avatar URL arrives with attachment-backed avatars, as for message authors.
    ...(row.createdBy === null ? {} : { createdBy: { id: row.createdBy.id, name: row.createdBy.name, avatarUrl: null } }),
  };
}

/**
 * The list status from the newest version: `processing` while it is processing, `failed` when it
 * failed and nothing is active, otherwise `ready`. A failed newest version beside an active one
 * keeps its `error`, so the admin sees why the edit was not applied while the old text still serves.
 */
function toDocumentDto(document: PolicyDocumentRow, newest: PolicyVersionRow | undefined, active: PolicyVersionRow | undefined): PolicyDocumentDto {
  let status: PolicyStatus = 'ready';
  if (newest?.status === 'processing') status = 'processing';
  else if (newest?.status === 'failed' && active === undefined) status = 'failed';
  const shown = active ?? newest;
  return {
    id: document.id,
    title: document.title,
    status,
    error: newest?.status === 'failed' ? newest.error : null,
    source: shown?.source ?? null,
    fileName: shown?.fileName ?? null,
    activeSince: active?.updatedAt.toISOString() ?? null,
    updatedAt: document.updatedAt.toISOString(),
  };
}

/**
 * `/ai/policies*` (contracts/ai.yaml, FR-006 to FR-008). A saved version is `processing` and the
 * `ai.policy_version_created` event is appended with it; the indexer (T015) makes it active.
 * Deleting a document is soft, and its passages go in the same transaction so it is never searched.
 */
@Injectable()
export class AiPoliciesService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly audience: AiAudience,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext): Promise<PolicyDocumentDto[]> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const documents = await repo.listDocuments(tx);
      const { newest, active } = await repo.summaries(
        tx,
        documents.map((document) => document.id),
      );
      return documents.map((document) => toDocumentDto(document, newest.get(document.id), active.get(document.id)));
    });
  }

  async get(ctx: TenantContext, id: string): Promise<PolicyDocumentDetailDto> {
    return this.unitOfWork.withTenantReadOnly(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const document = await repo.findDocument(tx, id);
      if (document === undefined) throw notFound('policy_document');
      const { newest, active } = await repo.summaries(tx, [id]);
      const activeVersion = active.get(id);
      return {
        ...toDocumentDto(document, newest.get(id), activeVersion),
        text: activeVersion?.source === 'text' ? await repo.activeText(tx, id) : null,
        versions: (await repo.recentVersions(tx, id, RECENT_VERSIONS)).map(toVersionDto),
      };
    });
  }

  async create(ctx: TenantContext, input: PolicyDocumentInput): Promise<PolicyDocumentDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const source = await this.checkSource(tx, ctx, repo, input);
      let documentId: string;
      try {
        documentId = await repo.insertDocument(tx, input.title, this.editorOf(ctx));
      } catch (error) {
        if (isTitleViolation(error)) throw titleTaken();
        throw error;
      }
      const versionId = await this.addVersion(tx, ctx, repo, documentId, source);
      await this.audit.record(tx, {
        action: 'ai_policy.created',
        resourceType: 'ai_policy',
        resourceId: documentId,
        details: { title: input.title, versionId, source: source.source, ...(source.fileName === null ? {} : { fileName: source.fileName }) },
      });
      return this.documentDto(tx, repo, documentId);
    });
  }

  async rename(ctx: TenantContext, id: string, title: string): Promise<PolicyDocumentDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const document = await repo.findDocument(tx, id, { forUpdate: true });
      if (document === undefined) throw notFound('policy_document');
      if (document.title !== title) {
        try {
          await repo.updateDocument(tx, id, { title }, this.clock.now());
        } catch (error) {
          if (isTitleViolation(error)) throw titleTaken();
          throw error;
        }
        await this.audit.record(tx, {
          action: 'ai_policy.renamed',
          resourceType: 'ai_policy',
          resourceId: id,
          details: { from: document.title, to: title },
        });
      }
      return this.documentDto(tx, repo, id);
    });
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    await this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const document = await repo.findDocument(tx, id, { forUpdate: true });
      if (document === undefined) throw notFound('policy_document');
      await repo.updateDocument(tx, id, { deletedAt: this.clock.now() }, this.clock.now());
      await repo.deleteChunks(tx, id);
      await this.audit.record(tx, { action: 'ai_policy.deleted', resourceType: 'ai_policy', resourceId: id, details: { title: document.title } });
    });
  }

  async createVersion(ctx: TenantContext, id: string, input: PolicyVersionInput): Promise<PolicyVersionDto> {
    return this.unitOfWork.withTenant(ctx, async (tx) => {
      const repo = new AiPoliciesRepository(ctx);
      const document = await repo.findDocument(tx, id, { forUpdate: true });
      if (document === undefined) throw notFound('policy_document');
      const source = await this.checkSource(tx, ctx, repo, input);
      const versionId = await this.addVersion(tx, ctx, repo, id, source);
      await repo.updateDocument(tx, id, {}, this.clock.now());
      await this.audit.record(tx, {
        action: 'ai_policy.version_created',
        resourceType: 'ai_policy',
        resourceId: id,
        details: { title: document.title, versionId, source: source.source, ...(source.fileName === null ? {} : { fileName: source.fileName }) },
      });
      const version = await repo.findVersion(tx, versionId);
      if (version === undefined) throw new Error('ai_policy_versions row missing after insert');
      return toVersionDto(version);
    });
  }

  /** Inserts a `processing` version and announces it to the indexer and the admins' Policies screen. */
  private async addVersion(tx: TenantTransaction, ctx: TenantContext, repo: AiPoliciesRepository, documentId: string, source: VersionSource): Promise<string> {
    const versionId = await repo.insertVersion(tx, {
      documentId,
      source: source.source,
      body: source.body,
      attachmentId: source.attachmentId,
      createdBy: this.editorOf(ctx),
    });
    await this.outbox.append(tx, {
      type: 'ai.policy_version_created',
      payload: { documentId, versionId },
      streams: await this.audience.streamsFor(tx, ctx, 'ai_knowledge.manage'),
    });
    return versionId;
  }

  private async documentDto(tx: TenantTransaction, repo: AiPoliciesRepository, id: string): Promise<PolicyDocumentDto> {
    const document = await repo.findDocument(tx, id);
    if (document === undefined) throw new Error('ai_policy_documents row missing after write');
    const { newest, active } = await repo.summaries(tx, [id]);
    return toDocumentDto(document, newest.get(id), active.get(id));
  }

  /**
   * A typed text, or an uploaded file the indexer can read: txt, md or pdf, at most 10 MB, sent by
   * an admin (a holder of `ai_knowledge.manage`) and not yet attached to a message. A file another
   * tenant uploaded is unknown here, like a missing one. A file still being scanned is accepted:
   * the indexer waits for the verdict (research R3); one already blocked is refused.
   */
  private async checkSource(
    tx: TenantTransaction,
    ctx: TenantContext,
    repo: AiPoliciesRepository,
    input: { text?: string | undefined; attachmentId?: string | undefined },
  ): Promise<VersionSource> {
    if (input.attachmentId === undefined) {
      if (input.text === undefined) throw validationFailed([{ path: 'text', issue: 'required' }]);
      return { source: 'text', body: input.text, attachmentId: null, fileName: null };
    }
    const attachment = await repo.findAttachment(tx, input.attachmentId);
    if (attachment === undefined || attachment.messageId !== null) throw validationFailed([{ path: 'attachmentId', issue: 'invalid_value' }]);
    const admins = await this.audience.holderIds(tx, ctx, 'ai_knowledge.manage');
    if (!admins.includes(attachment.uploadedBy)) throw validationFailed([{ path: 'attachmentId', issue: 'invalid_value' }]);
    if (FILE_TYPES[extname(attachment.fileName).toLowerCase()] !== attachment.contentType) {
      throw validationFailed([{ path: 'attachmentId', issue: 'invalid_format' }]);
    }
    if (attachment.sizeBytes > MAX_FILE_BYTES) throw validationFailed([{ path: 'attachmentId', issue: 'too_large' }]);
    if (attachment.scanStatus === 'blocked') throw conflict('ATTACHMENT_BLOCKED', 'This file was blocked by the malware scan');
    return { source: 'file', body: null, attachmentId: attachment.id, fileName: attachment.fileName };
  }

  private editorOf(ctx: TenantContext): string | null {
    return ctx.actor.kind === 'user' ? ctx.actor.id : null;
  }
}
