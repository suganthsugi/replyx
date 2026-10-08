import { toSql } from 'pgvector';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { PolicyChunk } from './policy-chunker.js';
import type { PolicyVersionError, PolicyVersionStatus } from '../../platform-kernel/db/tables/ai.js';
import type { ScanStatus } from '../../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

/** A version with what the indexer needs to read it: its body or its file, and whether its document is gone. */
export interface IndexableVersion {
  id: string;
  documentId: string;
  status: PolicyVersionStatus;
  source: 'text' | 'file';
  body: string | null;
  createdAt: Date;
  documentDeleted: boolean;
  file: { scanStatus: ScanStatus; contentType: string; attachmentId: string } | null;
}

export interface VersionStamp {
  id: string;
  createdAt: Date;
}

export interface EmbeddedChunk extends PolicyChunk {
  embedding: number[];
  model: string;
}

/** Rows per INSERT: each carries a 1 536-number vector. */
const INSERT_BATCH = 50;

/** Writes of the policy indexer (data-model.md `ai_policy_versions`, `ai_policy_chunks`). */
export class PolicyIndexRepository extends TenantRepository {
  async findVersion(tx: TenantTransaction, versionId: string): Promise<IndexableVersion | undefined> {
    const row = await this.selectFrom(tx, 'ai_policy_versions')
      .innerJoin('ai_policy_documents', (join) =>
        join.onRef('ai_policy_documents.tenant_id', '=', 'ai_policy_versions.tenant_id').onRef('ai_policy_documents.id', '=', 'ai_policy_versions.document_id'),
      )
      .leftJoin('attachments', (join) =>
        join.onRef('attachments.tenant_id', '=', 'ai_policy_versions.tenant_id').onRef('attachments.id', '=', 'ai_policy_versions.attachment_id'),
      )
      .select([
        'ai_policy_versions.id',
        'ai_policy_versions.document_id',
        'ai_policy_versions.status',
        'ai_policy_versions.source',
        'ai_policy_versions.body',
        'ai_policy_versions.created_at',
        'ai_policy_documents.deleted_at as document_deleted_at',
        'attachments.id as attachment_id',
        'attachments.scan_status',
        'attachments.content_type',
      ])
      .where('ai_policy_versions.id', '=', versionId)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      documentId: row.document_id,
      status: row.status,
      source: row.source,
      body: row.body,
      createdAt: row.created_at,
      documentDeleted: row.document_deleted_at !== null,
      file:
        row.attachment_id === null || row.scan_status === null || row.content_type === null
          ? null
          : { attachmentId: row.attachment_id, scanStatus: row.scan_status, contentType: row.content_type },
    };
  }

  /** Locks the document so a delete, a rename and a concurrent swap queue behind each other. */
  async lockDocument(tx: TenantTransaction, documentId: string): Promise<{ deleted: boolean } | undefined> {
    const row = await this.selectFrom(tx, 'ai_policy_documents')
      .select(['ai_policy_documents.id', 'ai_policy_documents.deleted_at'])
      .where('ai_policy_documents.id', '=', documentId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : { deleted: row.deleted_at !== null };
  }

  /** The version's current status, locked. */
  async lockVersionStatus(tx: TenantTransaction, versionId: string): Promise<PolicyVersionStatus | undefined> {
    const row = await this.selectFrom(tx, 'ai_policy_versions')
      .select('ai_policy_versions.status')
      .where('ai_policy_versions.id', '=', versionId)
      .forUpdate()
      .executeTakeFirst();
    return row?.status;
  }

  async activeVersion(tx: TenantTransaction, documentId: string): Promise<VersionStamp | undefined> {
    const row = await this.selectFrom(tx, 'ai_policy_versions')
      .select(['ai_policy_versions.id', 'ai_policy_versions.created_at'])
      .where('ai_policy_versions.document_id', '=', documentId)
      .where('ai_policy_versions.status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, createdAt: row.created_at };
  }

  async markFailed(tx: TenantTransaction, versionId: string, error: PolicyVersionError, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_policy_versions').set({ status: 'failed', error, updated_at: now }).where('ai_policy_versions.id', '=', versionId).execute();
  }

  async markSuperseded(tx: TenantTransaction, versionId: string, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_policy_versions').set({ status: 'superseded', updated_at: now }).where('ai_policy_versions.id', '=', versionId).execute();
  }

  /**
   * The swap (FR-008): the previous active version becomes `superseded` and its passages go, the new
   * passages are stored, and the version and the document point at them. The caller holds the
   * document lock, so a reader sees either the old text or the new one, never a mix.
   */
  async activate(
    tx: TenantTransaction,
    params: { documentId: string; versionId: string; chunks: readonly EmbeddedChunk[]; extractedChars: number; now: Date },
  ): Promise<void> {
    const { documentId, versionId, chunks, now } = params;
    await this.updateTable(tx, 'ai_policy_versions')
      .set({ status: 'superseded', updated_at: now })
      .where('ai_policy_versions.document_id', '=', documentId)
      .where('ai_policy_versions.status', '=', 'active')
      .execute();
    await this.deleteFrom(tx, 'ai_policy_chunks').where('ai_policy_chunks.document_id', '=', documentId).execute();

    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      const rows = chunks.slice(start, start + INSERT_BATCH).map((chunk, offset) => ({
        version_id: versionId,
        document_id: documentId,
        ordinal: start + offset,
        heading: chunk.heading,
        content: chunk.content,
        embedding: toSql(chunk.embedding) as string,
        embedding_model: chunk.model,
      }));
      await this.insertInto(tx, 'ai_policy_chunks', rows).execute();
    }

    await this.updateTable(tx, 'ai_policy_versions')
      .set({ status: 'active', error: null, extracted_chars: params.extractedChars, updated_at: now })
      .where('ai_policy_versions.id', '=', versionId)
      .execute();
    await this.updateTable(tx, 'ai_policy_documents')
      .set({ active_version_id: versionId, updated_at: now })
      .where('ai_policy_documents.id', '=', documentId)
      .execute();
  }
}
