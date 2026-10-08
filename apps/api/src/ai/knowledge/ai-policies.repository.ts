import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';

import type { PolicyVersionError, PolicyVersionSource, PolicyVersionStatus } from '../../platform-kernel/db/tables/ai.js';
import type { ScanStatus } from '../../platform-kernel/db/tables/tickets.js';
import type { TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';

export interface PolicyDocumentRow {
  id: string;
  title: string;
  updatedAt: Date;
}

/** A version without its body (which can be 200 000 characters); `fileName` is set for files. */
export interface PolicyVersionRow {
  id: string;
  documentId: string;
  source: PolicyVersionSource;
  status: PolicyVersionStatus;
  error: PolicyVersionError | null;
  fileName: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PolicyAttachmentRow {
  id: string;
  uploadedBy: string;
  messageId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
}

export interface NewPolicyVersion {
  documentId: string;
  source: PolicyVersionSource;
  body: string | null;
  attachmentId: string | null;
  createdBy: string | null;
}

/** `ai_policy_documents`, `ai_policy_versions` and the chunks of a document (data-model.md). */
export class AiPoliciesRepository extends TenantRepository {
  /** Non-deleted documents, by title. */
  async listDocuments(tx: TenantTransaction): Promise<PolicyDocumentRow[]> {
    const rows = await this.selectFrom(tx, 'ai_policy_documents')
      .select(['ai_policy_documents.id', 'ai_policy_documents.title', 'ai_policy_documents.updated_at'])
      .where('ai_policy_documents.deleted_at', 'is', null)
      .orderBy((eb) => eb.fn('lower', ['ai_policy_documents.title']))
      .orderBy('ai_policy_documents.id')
      .execute();
    return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
  }

  /** A non-deleted document; `forUpdate` serializes concurrent version writes and renames. */
  async findDocument(tx: TenantTransaction, id: string, options: { forUpdate?: boolean } = {}): Promise<PolicyDocumentRow | undefined> {
    let query = this.selectFrom(tx, 'ai_policy_documents')
      .select(['ai_policy_documents.id', 'ai_policy_documents.title', 'ai_policy_documents.updated_at'])
      .where('ai_policy_documents.id', '=', id)
      .where('ai_policy_documents.deleted_at', 'is', null);
    if (options.forUpdate === true) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, title: row.title, updatedAt: row.updated_at };
  }

  async insertDocument(tx: TenantTransaction, title: string, createdBy: string | null): Promise<string> {
    const row = await this.insertInto(tx, 'ai_policy_documents', { title, created_by: createdBy }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  async updateDocument(tx: TenantTransaction, id: string, change: { title?: string; deletedAt?: Date }, now: Date): Promise<void> {
    await this.updateTable(tx, 'ai_policy_documents')
      .set({
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.deletedAt === undefined ? {} : { deleted_at: change.deletedAt }),
        updated_at: now,
      })
      .where('ai_policy_documents.id', '=', id)
      .execute();
  }

  /** Every passage of the document, whatever the version (a deleted document is never searched). */
  async deleteChunks(tx: TenantTransaction, documentId: string): Promise<void> {
    await this.deleteFrom(tx, 'ai_policy_chunks').where('ai_policy_chunks.document_id', '=', documentId).execute();
  }

  async insertVersion(tx: TenantTransaction, version: NewPolicyVersion): Promise<string> {
    const row = await this.insertInto(tx, 'ai_policy_versions', {
      document_id: version.documentId,
      source: version.source,
      body: version.body,
      attachment_id: version.attachmentId,
      created_by: version.createdBy,
    })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The newest version of each document, and its active one when it has one. */
  async summaries(
    tx: TenantTransaction,
    documentIds: readonly string[],
  ): Promise<{ newest: Map<string, PolicyVersionRow>; active: Map<string, PolicyVersionRow> }> {
    const newest = new Map<string, PolicyVersionRow>();
    const active = new Map<string, PolicyVersionRow>();
    if (documentIds.length === 0) return { newest, active };

    const newestRows = await this.versionQuery(tx)
      .distinctOn('ai_policy_versions.document_id')
      .where('ai_policy_versions.document_id', 'in', documentIds)
      .orderBy('ai_policy_versions.document_id')
      .orderBy('ai_policy_versions.created_at', 'desc')
      .orderBy('ai_policy_versions.id', 'desc')
      .execute();
    for (const row of newestRows) newest.set(row.document_id, toVersionRow(row));

    const activeRows = await this.versionQuery(tx)
      .where('ai_policy_versions.document_id', 'in', documentIds)
      .where('ai_policy_versions.status', '=', 'active')
      .execute();
    for (const row of activeRows) active.set(row.document_id, toVersionRow(row));
    return { newest, active };
  }

  /** The newest versions of one document, newest first. */
  async recentVersions(tx: TenantTransaction, documentId: string, limit: number): Promise<PolicyVersionRow[]> {
    const rows = await this.versionQuery(tx)
      .where('ai_policy_versions.document_id', '=', documentId)
      .orderBy('ai_policy_versions.created_at', 'desc')
      .orderBy('ai_policy_versions.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toVersionRow);
  }

  async findVersion(tx: TenantTransaction, id: string): Promise<PolicyVersionRow | undefined> {
    const row = await this.versionQuery(tx).where('ai_policy_versions.id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toVersionRow(row);
  }

  /** The text of the document's active version when it was typed in. */
  async activeText(tx: TenantTransaction, documentId: string): Promise<string | null> {
    const row = await this.selectFrom(tx, 'ai_policy_versions')
      .select('ai_policy_versions.body')
      .where('ai_policy_versions.document_id', '=', documentId)
      .where('ai_policy_versions.status', '=', 'active')
      .executeTakeFirst();
    return row?.body ?? null;
  }

  async findAttachment(tx: TenantTransaction, id: string): Promise<PolicyAttachmentRow | undefined> {
    const row = await this.selectFrom(tx, 'attachments')
      .select([
        'attachments.id',
        'attachments.uploaded_by',
        'attachments.message_id',
        'attachments.file_name',
        'attachments.content_type',
        'attachments.size_bytes',
        'attachments.scan_status',
      ])
      .where('attachments.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      uploadedBy: row.uploaded_by,
      messageId: row.message_id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      scanStatus: row.scan_status,
    };
  }

  private versionQuery(tx: TenantTransaction) {
    return this.selectFrom(tx, 'ai_policy_versions')
      .leftJoin('attachments', (join) =>
        join.onRef('attachments.tenant_id', '=', 'ai_policy_versions.tenant_id').onRef('attachments.id', '=', 'ai_policy_versions.attachment_id'),
      )
      .leftJoin('users', (join) =>
        join.onRef('users.tenant_id', '=', 'ai_policy_versions.tenant_id').onRef('users.id', '=', 'ai_policy_versions.created_by'),
      )
      .select([
        'ai_policy_versions.id',
        'ai_policy_versions.document_id',
        'ai_policy_versions.source',
        'ai_policy_versions.status',
        'ai_policy_versions.error',
        'ai_policy_versions.created_by',
        'ai_policy_versions.created_at',
        'ai_policy_versions.updated_at',
        'attachments.file_name',
        'users.name as creator_name',
      ]);
  }
}

interface VersionQueryRow {
  id: string;
  document_id: string;
  source: PolicyVersionSource;
  status: PolicyVersionStatus;
  error: PolicyVersionError | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  file_name: string | null;
  creator_name: string | null;
}

function toVersionRow(row: VersionQueryRow): PolicyVersionRow {
  return {
    id: row.id,
    documentId: row.document_id,
    source: row.source,
    status: row.status,
    error: row.error,
    fileName: row.file_name,
    createdBy: row.created_by === null || row.creator_name === null ? null : { id: row.created_by, name: row.creator_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
