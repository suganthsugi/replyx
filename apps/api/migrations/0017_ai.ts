import { sql, type Kysely } from 'kysely';

/**
 * AI Assist (specs/002-ai-assist, data-model.md; T003; module: AI).
 *
 * - `vector` (pgvector) is created by the superuser: `infra/postgres/init.sql` on new volumes and
 *   `infra/scripts/deploy.sh` before migrations. It is not a trusted extension, so the owner role
 *   that runs this migration cannot create it; `IF NOT EXISTS` makes this line a no-op then, and it
 *   fails loudly on a database where nobody created it.
 * - Keys (`*_sealed`) are AES-256-GCM `v1:` strings from `platform-kernel/crypto/secret-box.ts`;
 *   only `*_last4` is ever shown.
 * - Message and turn ids (`trigger_message_id`, `message_id`) carry no foreign key: messages can
 *   move between tickets (merge, FR-042) and turns must survive that as an audit of what ran.
 * - Rows that belong to a ticket cascade with it (retention deletes tickets); `ai_runs` keeps the
 *   usage record and only loses the ticket link.
 * - Policy chunks use HNSW (cosine) plus the same `simple` + `replyx_unaccent` full-text setup as
 *   search (0015). Only chunks of the active version exist (research R3, R4), so retrieval needs
 *   no status join. Queries set `hnsw.iterative_scan` so the tenant filter does not starve results.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`.execute(db);

  // --- Existing tables ---------------------------------------------------------------------------
  await sql`ALTER TABLE ticket_messages DROP CONSTRAINT ticket_messages_author_kind`.execute(db);
  await sql`
    ALTER TABLE ticket_messages
      ADD CONSTRAINT ticket_messages_author_kind
        CHECK (author_kind IN ('customer', 'staff', 'system', 'automation', 'assistant')),
      ADD COLUMN metadata jsonb,
      ADD CONSTRAINT ticket_messages_metadata_object CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object')
  `.execute(db);

  await sql`ALTER TABLE ticket_history DROP CONSTRAINT ticket_history_actor_kind`.execute(db);
  await sql`
    ALTER TABLE ticket_history ADD CONSTRAINT ticket_history_actor_kind
      CHECK (actor_kind IN ('user', 'operator', 'system', 'automation', 'routing', 'ai'))
  `.execute(db);

  await sql`
    ALTER TABLE groups
      ADD COLUMN ai_description text,
      ADD CONSTRAINT groups_ai_description_length CHECK (char_length(ai_description) BETWEEN 1 AND 500)
  `.execute(db);

  // --- Settings ------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE ai_settings (
      tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
      reply_mode text NOT NULL DEFAULT 'off',
      routing_enabled boolean NOT NULL DEFAULT false,
      routing_threshold numeric(3,2) NOT NULL DEFAULT 0.70,
      models jsonb NOT NULL DEFAULT '{}'::jsonb,
      provider text NOT NULL DEFAULT 'openrouter',
      provider_key_sealed text,
      provider_key_last4 text,
      paused_reason text,
      paused_at timestamptz,
      complexity_thresholds jsonb NOT NULL DEFAULT '{"standard": 0.45, "advanced": 0.8}'::jsonb,
      updated_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_settings_updated_by_fk FOREIGN KEY (tenant_id, updated_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (updated_by),
      CONSTRAINT ai_settings_reply_mode CHECK (reply_mode IN ('off', 'drafts', 'auto')),
      CONSTRAINT ai_settings_routing_threshold CHECK (routing_threshold BETWEEN 0.50 AND 0.99),
      CONSTRAINT ai_settings_models_object CHECK (jsonb_typeof(models) = 'object'),
      CONSTRAINT ai_settings_provider CHECK (provider IN ('openrouter')),
      CONSTRAINT ai_settings_key_pair CHECK ((provider_key_sealed IS NULL) = (provider_key_last4 IS NULL)),
      CONSTRAINT ai_settings_paused_reason CHECK (paused_reason IN ('invalid_key', 'no_credit')),
      CONSTRAINT ai_settings_paused_pair CHECK ((paused_reason IS NULL) = (paused_at IS NULL)),
      CONSTRAINT ai_settings_thresholds_object CHECK (jsonb_typeof(complexity_thresholds) = 'object')
    )
  `.execute(db);

  await sql`
    CREATE TABLE ai_store_connections (
      tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
      kind text NOT NULL,
      base_url text NOT NULL,
      api_key_sealed text NOT NULL,
      api_key_last4 text NOT NULL,
      last_test_at timestamptz,
      last_test_ok boolean,
      last_test_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_store_connections_kind CHECK (kind IN ('spree')),
      CONSTRAINT ai_store_connections_base_url_length CHECK (char_length(base_url) BETWEEN 1 AND 300)
    )
  `.execute(db);

  await sql`
    CREATE TABLE ai_complexity_factors (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      position integer NOT NULL,
      kind text NOT NULL,
      key text NOT NULL,
      label text NOT NULL,
      definition jsonb NOT NULL DEFAULT '{}'::jsonb,
      weight numeric(4,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_complexity_factors_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_complexity_factors_tenant_key UNIQUE (tenant_id, key),
      CONSTRAINT ai_complexity_factors_kind
        CHECK (kind IN ('noul', 'choice', 'score', 'customer_tag', 'reopen_count', 'sla_breached')),
      CONSTRAINT ai_complexity_factors_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
      CONSTRAINT ai_complexity_factors_label_length CHECK (char_length(label) BETWEEN 1 AND 80),
      CONSTRAINT ai_complexity_factors_definition_object CHECK (jsonb_typeof(definition) = 'object'),
      CONSTRAINT ai_complexity_factors_weight CHECK (weight BETWEEN 0 AND 10)
    )
  `.execute(db);
  await sql`CREATE INDEX ai_complexity_factors_tenant_position ON ai_complexity_factors (tenant_id, position)`.execute(db);

  // --- Policy knowledge ------------------------------------------------------------------------
  await sql`
    CREATE TABLE ai_policy_documents (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      title text NOT NULL,
      active_version_id uuid,
      deleted_at timestamptz,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_policy_documents_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_policy_documents_created_by_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by),
      CONSTRAINT ai_policy_documents_title_length CHECK (char_length(title) BETWEEN 1 AND 200)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX ai_policy_documents_tenant_title ON ai_policy_documents (tenant_id, lower(title))
      WHERE deleted_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE ai_policy_versions (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      document_id uuid NOT NULL,
      source text NOT NULL,
      body text,
      attachment_id uuid,
      extracted_chars integer,
      status text NOT NULL DEFAULT 'processing',
      error text,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_policy_versions_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_policy_versions_document_fk FOREIGN KEY (tenant_id, document_id)
        REFERENCES ai_policy_documents (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_policy_versions_attachment_fk FOREIGN KEY (tenant_id, attachment_id)
        REFERENCES attachments (tenant_id, id),
      CONSTRAINT ai_policy_versions_created_by_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by),
      CONSTRAINT ai_policy_versions_source CHECK (
        (source = 'text' AND body IS NOT NULL AND attachment_id IS NULL)
        OR (source = 'file' AND attachment_id IS NOT NULL AND body IS NULL)
      ),
      CONSTRAINT ai_policy_versions_body_length CHECK (char_length(body) BETWEEN 1 AND 200000),
      CONSTRAINT ai_policy_versions_status CHECK (status IN ('processing', 'active', 'failed', 'superseded')),
      CONSTRAINT ai_policy_versions_error CHECK ((status = 'failed') = (error IS NOT NULL))
    )
  `.execute(db);
  await sql`CREATE INDEX ai_policy_versions_document ON ai_policy_versions (tenant_id, document_id, created_at DESC)`.execute(db);
  // At most one active version per document; the swap supersedes the old one in the same transaction.
  await sql`
    CREATE UNIQUE INDEX ai_policy_versions_one_active ON ai_policy_versions (tenant_id, document_id)
      WHERE status = 'active'
  `.execute(db);
  await sql`
    ALTER TABLE ai_policy_documents ADD CONSTRAINT ai_policy_documents_active_version_fk
      FOREIGN KEY (tenant_id, active_version_id) REFERENCES ai_policy_versions (tenant_id, id)
      ON DELETE SET NULL (active_version_id)
  `.execute(db);

  await sql`
    CREATE TABLE ai_policy_chunks (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      version_id uuid NOT NULL,
      document_id uuid NOT NULL,
      ordinal integer NOT NULL,
      heading text,
      content text NOT NULL,
      embedding vector(1536) NOT NULL,
      embedding_model text NOT NULL,
      search tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', public.replyx_unaccent(coalesce(heading, '') || ' ' || content))
      ) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_policy_chunks_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_policy_chunks_version_fk FOREIGN KEY (tenant_id, version_id)
        REFERENCES ai_policy_versions (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_policy_chunks_document_fk FOREIGN KEY (tenant_id, document_id)
        REFERENCES ai_policy_documents (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_policy_chunks_content_length CHECK (char_length(content) BETWEEN 1 AND 8000)
    )
  `.execute(db);
  await sql`CREATE INDEX ai_policy_chunks_version ON ai_policy_chunks (tenant_id, version_id, ordinal)`.execute(db);
  await sql`CREATE INDEX ai_policy_chunks_embedding ON ai_policy_chunks USING hnsw (embedding vector_cosine_ops)`.execute(db);
  await sql`CREATE INDEX ai_policy_chunks_search ON ai_policy_chunks USING gin (search)`.execute(db);

  // --- Per-ticket assistant ----------------------------------------------------------------------
  await sql`
    CREATE TABLE ai_ticket_state (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      stopped_reason text,
      taken_over_by uuid,
      agent_replied_at timestamptz,
      awaiting text,
      unresolved_turns integer NOT NULL DEFAULT 0,
      summary text,
      summary_upto_message_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, ticket_id),
      CONSTRAINT ai_ticket_state_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_ticket_state_taken_over_by_fk FOREIGN KEY (tenant_id, taken_over_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (taken_over_by),
      CONSTRAINT ai_ticket_state_stopped_reason
        CHECK (stopped_reason ~ '^(handoff:[a-z_]{1,40}|agent_replied|taken_over)$'),
      CONSTRAINT ai_ticket_state_awaiting CHECK (awaiting IN ('order_number', 'other')),
      CONSTRAINT ai_ticket_state_unresolved CHECK (unresolved_turns >= 0)
    )
  `.execute(db);

  await sql`
    CREATE TABLE ai_turns (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      trigger_message_id uuid NOT NULL,
      outcome text NOT NULL,
      level text,
      complexity_score numeric(4,3),
      message_id uuid,
      draft_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_turns_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_turns_once_per_message UNIQUE (tenant_id, ticket_id, trigger_message_id),
      CONSTRAINT ai_turns_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_turns_outcome CHECK (outcome IN ('replied', 'drafted', 'handoff', 'skipped')),
      CONSTRAINT ai_turns_level CHECK (level IN ('fast', 'standard', 'advanced')),
      CONSTRAINT ai_turns_score CHECK (complexity_score BETWEEN 0 AND 1)
    )
  `.execute(db);

  await sql`
    CREATE TABLE ai_drafts (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid NOT NULL,
      turn_id uuid NOT NULL,
      body text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      resolved_by uuid,
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_drafts_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_drafts_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_drafts_turn_fk FOREIGN KEY (tenant_id, turn_id)
        REFERENCES ai_turns (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT ai_drafts_resolved_by_fk FOREIGN KEY (tenant_id, resolved_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (resolved_by),
      CONSTRAINT ai_drafts_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
      CONSTRAINT ai_drafts_status CHECK (status IN ('open', 'sent', 'discarded', 'superseded')),
      CONSTRAINT ai_drafts_resolved CHECK ((status = 'open') = (resolved_at IS NULL))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX ai_drafts_one_open ON ai_drafts (tenant_id, ticket_id) WHERE status = 'open'`.execute(db);

  await sql`
    CREATE TABLE ai_runs (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      ticket_id uuid,
      turn_id uuid,
      purpose text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      level text,
      complexity_score numeric(4,3),
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cost_usd numeric(12,6),
      cost_estimated boolean NOT NULL DEFAULT false,
      duration_ms integer NOT NULL,
      outcome text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_runs_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT ai_runs_ticket_fk FOREIGN KEY (tenant_id, ticket_id)
        REFERENCES tickets (tenant_id, id) ON DELETE SET NULL (ticket_id),
      CONSTRAINT ai_runs_turn_fk FOREIGN KEY (tenant_id, turn_id)
        REFERENCES ai_turns (tenant_id, id) ON DELETE SET NULL (turn_id),
      CONSTRAINT ai_runs_purpose
        CHECK (purpose IN ('routing', 'complexity', 'reply', 'draft', 'summary', 'embedding', 'connection_test')),
      CONSTRAINT ai_runs_level CHECK (level IN ('fast', 'standard', 'advanced')),
      CONSTRAINT ai_runs_score CHECK (complexity_score BETWEEN 0 AND 1),
      CONSTRAINT ai_runs_tokens CHECK (input_tokens >= 0 AND output_tokens >= 0),
      CONSTRAINT ai_runs_duration CHECK (duration_ms >= 0),
      CONSTRAINT ai_runs_outcome
        CHECK (outcome IN ('ok', 'auth', 'credit', 'rate_limit', 'timeout', 'unavailable', 'bad_request'))
    )
  `.execute(db);
  await sql`CREATE INDEX ai_runs_tenant_created ON ai_runs (tenant_id, created_at DESC, id DESC)`.execute(db);

  // --- Triggers, RLS, grants ---------------------------------------------------------------------
  for (const table of [
    'ai_settings',
    'ai_store_connections',
    'ai_complexity_factors',
    'ai_policy_documents',
    'ai_policy_versions',
    'ai_ticket_state',
    'ai_drafts',
  ]) {
    await sql`
      CREATE TRIGGER ${sql.raw(`${table}_touch`)} BEFORE UPDATE ON ${sql.table(table)}
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
    `.execute(db);
  }
  for (const table of [
    'ai_settings',
    'ai_store_connections',
    'ai_complexity_factors',
    'ai_policy_documents',
    'ai_policy_versions',
    'ai_policy_chunks',
    'ai_ticket_state',
    'ai_turns',
    'ai_drafts',
    'ai_runs',
  ]) {
    await sql`SELECT enable_tenant_rls(${table})`.execute(db);
    await sql`SELECT grant_app_dml(${table})`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE ai_runs, ai_drafts, ai_turns, ai_ticket_state, ai_policy_chunks`.execute(db);
  await sql`ALTER TABLE ai_policy_documents DROP CONSTRAINT ai_policy_documents_active_version_fk`.execute(db);
  await sql`DROP TABLE ai_policy_versions, ai_policy_documents, ai_complexity_factors, ai_store_connections, ai_settings`.execute(db);
  await sql`ALTER TABLE groups DROP CONSTRAINT groups_ai_description_length, DROP COLUMN ai_description`.execute(db);
  await sql`ALTER TABLE ticket_history DROP CONSTRAINT ticket_history_actor_kind`.execute(db);
  await sql`
    ALTER TABLE ticket_history ADD CONSTRAINT ticket_history_actor_kind
      CHECK (actor_kind IN ('user', 'operator', 'system', 'automation', 'routing'))
  `.execute(db);
  await sql`
    ALTER TABLE ticket_messages
      DROP CONSTRAINT ticket_messages_metadata_object,
      DROP COLUMN metadata,
      DROP CONSTRAINT ticket_messages_author_kind
  `.execute(db);
  await sql`
    ALTER TABLE ticket_messages ADD CONSTRAINT ticket_messages_author_kind
      CHECK (author_kind IN ('customer', 'staff', 'system', 'automation'))
  `.execute(db);
}
