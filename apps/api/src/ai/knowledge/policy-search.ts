import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { toSql } from 'pgvector';

import { TenantRepository } from '../../platform-kernel/db/tenant-repository.js';
import { UnitOfWork, type TenantTransaction } from '../../platform-kernel/db/unit-of-work.js';
import { EMBEDDING_MODEL } from '../providers/catalog.js';
import { AI_PROVIDER, ProviderError, type AiProvider } from '../providers/ports.js';
import { AiRunsRecorder } from '../runs/ai-runs.recorder.js';
import { AiStatus } from '../settings/ai-status.js';

import type { TenantContext } from '../../platform-kernel/db/tenant-context.js';

/** One passage the assistant may quote (FR-009). */
export interface PolicyPassage {
  documentTitle: string;
  heading: string | null;
  content: string;
}

/** Candidates taken from each ranking, the Reciprocal Rank Fusion constant, and passages returned. */
const CANDIDATES = 20;
const RRF_K = 60;
const RESULTS = 6;
/** The embedded query is cut here; a customer question is far shorter. */
const MAX_QUERY_CHARS = 2000;
const MAX_TOKENS = 40;

/** Common English words that would match every passage; the `simple` text config drops none. */
const STOP_WORDS = new Set(
  'the and for are but not you your yours with this that have has had was were can could would should will what when where which who how why does did from they them their there about into than then just also any all our out its'.split(' '),
);

/** Words of the query for the full-text side: letters and digits only, so none can be tsquery syntax. */
export function queryTokens(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word) && (word.length > 1 || /\d/.test(word))))].slice(0, MAX_TOKENS);
}

/**
 * Policy retrieval for the assistant (research R3): the closest passages by embedding (cosine, HNSW)
 * and the best full-text matches, merged by Reciprocal Rank Fusion, top 6. Only passages of active
 * versions of non-deleted documents of the tenant are searched.
 *
 * The query is embedded with the tenant's own key (one `ai_runs` row, purpose `embedding`) before
 * the read transaction opens. An `auth`/`credit` error pauses the tenant and, like any provider
 * error, is rethrown for the caller to handle. A paused tenant or one with no key skips the embedding and gets full-text results only.
 */
@Injectable()
export class PolicySearch {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly status: AiStatus,
    private readonly runs: AiRunsRecorder,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  async search(ctx: TenantContext, query: string, options: { ticketId?: string; turnId?: string } = {}): Promise<PolicyPassage[]> {
    const text = query.trim().slice(0, MAX_QUERY_CHARS);
    if (text.length === 0) return [];
    const tokens = queryTokens(text);

    const settings = await this.status.settings(ctx);
    // A paused tenant's key is known to be bad: no call is made, and full-text results still answer.
    const credentials = settings.pausedReason === null ? this.status.credentials(settings) : undefined;
    let embedding: number[] | undefined;
    if (credentials !== undefined) {
      try {
        const result = await this.runs.track(
          ctx,
          { purpose: 'embedding', model: EMBEDDING_MODEL.id, ticketId: options.ticketId ?? null, turnId: options.turnId ?? null },
          () => this.provider.embed(credentials, { model: EMBEDDING_MODEL.id, inputs: [text] }),
        );
        embedding = result.vectors[0];
      } catch (error) {
        if (error instanceof ProviderError) await this.status.pauseFor(ctx, error);
        throw error;
      }
    }
    return this.unitOfWork.withTenantReadOnly(ctx, (tx) => new PolicySearchRepository(ctx).search(tx, tokens, embedding));
  }
}

class PolicySearchRepository extends TenantRepository {
  async search(tx: TenantTransaction, tokens: readonly string[], embedding: number[] | undefined): Promise<PolicyPassage[]> {
    if (tokens.length === 0 && embedding === undefined) return [];
    const tenantId = this.ctx.tenantId;
    // Keeps the HNSW scan going past the tenant filter until it has enough rows (pgvector 0.8).
    await sql`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`.execute(tx);

    const vector = embedding === undefined ? undefined : (toSql(embedding) ?? undefined);
    const vectorRanking =
      vector === undefined
        ? sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`
        : sql`
          SELECT ranked.id, row_number() OVER (ORDER BY ranked.distance) AS rank
          FROM (
            SELECT c.id, c.embedding <=> ${vector}::vector AS distance
            FROM ai_policy_chunks c
            WHERE c.tenant_id = ${tenantId}::uuid
            ORDER BY c.embedding <=> ${vector}::vector
            LIMIT ${sql.lit(CANDIDATES)}
          ) ranked`;
    const textRanking =
      tokens.length === 0
        ? sql`SELECT NULL::uuid AS id, NULL::bigint AS rank WHERE false`
        : sql`
          SELECT ranked.id, row_number() OVER (ORDER BY ranked.score DESC, ranked.id) AS rank
          FROM (
            SELECT c.id, ts_rank_cd(c.search, q.query) AS score
            FROM ai_policy_chunks c
            CROSS JOIN (
              SELECT to_tsquery('simple', string_agg(w.word, ' | ')) AS query
              FROM (
                SELECT DISTINCT public.replyx_unaccent(tok) AS word FROM unnest(${[...tokens]}::text[]) AS tok
              ) w
              WHERE w.word ~ '^[[:alnum:]]+$'
            ) q
            WHERE c.tenant_id = ${tenantId}::uuid AND c.search @@ q.query
            ORDER BY score DESC, c.id
            LIMIT ${sql.lit(CANDIDATES)}
          ) ranked`;

    const result = await sql<{ document_title: string; heading: string | null; content: string }>`
      WITH vector_ranking AS (${vectorRanking}),
      text_ranking AS (${textRanking}),
      fused AS (
        SELECT COALESCE(v.id, t.id) AS id,
               COALESCE(1.0 / (${sql.lit(RRF_K)} + v.rank), 0) + COALESCE(1.0 / (${sql.lit(RRF_K)} + t.rank), 0) AS score
        FROM vector_ranking v
        FULL OUTER JOIN text_ranking t ON t.id = v.id
      )
      SELECT d.title AS document_title, c.heading, c.content
      FROM fused f
      JOIN ai_policy_chunks c ON c.tenant_id = ${tenantId}::uuid AND c.id = f.id
      JOIN ai_policy_documents d
        ON d.tenant_id = c.tenant_id AND d.id = c.document_id AND d.active_version_id = c.version_id AND d.deleted_at IS NULL
      ORDER BY f.score DESC, c.document_id, c.ordinal
      LIMIT ${sql.lit(RESULTS)}`.execute(tx);
    return result.rows.map((row) => ({ documentTitle: row.document_title, heading: row.heading, content: row.content }));
  }
}
