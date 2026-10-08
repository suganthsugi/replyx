import type { ColumnType, Generated, GeneratedTimestamp, Timestamp } from './column-types.js';

/** Migration 0017_ai (specs/002-ai-assist/data-model.md). */

export type AiReplyMode = 'off' | 'drafts' | 'auto';
export type AiModelLevel = 'fast' | 'standard' | 'advanced';
export type AiPauseReason = 'invalid_key' | 'no_credit';
export type AiProviderName = 'openrouter';

/** Model id per level; a missing level falls back to the catalog default. */
export type AiLevelModels = Partial<Record<AiModelLevel, string>>;

/** Score ≥ `standard` uses Standard, ≥ `advanced` uses Advanced (0 < standard < advanced < 1). */
export interface AiComplexityThresholds {
  standard: number;
  advanced: number;
}

/** numeric: pg returns it as a string. */
type Numeric = ColumnType<string, number | string, number | string>;
type NullableNumeric = ColumnType<string | null, number | string | null | undefined, number | string | null>;
/** jsonb: read as an object, written as a JSON string (the pg driver does not serialize objects). */
type Json<T> = ColumnType<T, string | undefined, string>;

export interface AiSettingsTable {
  tenant_id: string;
  reply_mode: Generated<AiReplyMode>;
  routing_enabled: Generated<boolean>;
  routing_threshold: ColumnType<string, number | string | undefined, number | string>;
  models: Json<AiLevelModels>;
  provider: Generated<AiProviderName>;
  /** secret-box `v1:` string; never leaves the API. */
  provider_key_sealed: string | null;
  provider_key_last4: string | null;
  paused_reason: AiPauseReason | null;
  paused_at: Timestamp | null;
  complexity_thresholds: Json<AiComplexityThresholds>;
  updated_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type StoreKind = 'spree';

export interface AiStoreConnectionsTable {
  tenant_id: string;
  kind: StoreKind;
  base_url: string;
  api_key_sealed: string;
  api_key_last4: string;
  last_test_at: Timestamp | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ComplexityFactorKind = 'noul' | 'choice' | 'score' | 'customer_tag' | 'reopen_count' | 'sla_breached';

/** Shape depends on `kind` (contracts/ai.yaml `ComplexityFactor`); validated by the complexity service. */
export interface ComplexityFactorDefinition {
  instructions?: string;
  criteria?: { true: string; false: string };
  options?: { key: string; description: string; value: number }[];
  levels?: string[];
  tagId?: string;
}

export interface AiComplexityFactorsTable {
  id: Generated<string>;
  tenant_id: string;
  position: number;
  kind: ComplexityFactorKind;
  key: string;
  label: string;
  definition: Json<ComplexityFactorDefinition>;
  weight: Numeric;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AiPolicyDocumentsTable {
  id: Generated<string>;
  tenant_id: string;
  title: string;
  active_version_id: string | null;
  deleted_at: Timestamp | null;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PolicyVersionSource = 'text' | 'file';
export type PolicyVersionStatus = 'processing' | 'active' | 'failed' | 'superseded';
export type PolicyVersionError = 'no_extractable_text' | 'blocked_by_scan' | 'too_large' | 'unsupported_type' | 'embedding_failed';

export interface AiPolicyVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  document_id: string;
  source: PolicyVersionSource;
  body: string | null;
  attachment_id: string | null;
  extracted_chars: number | null;
  status: Generated<PolicyVersionStatus>;
  error: PolicyVersionError | null;
  created_by: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AiPolicyChunksTable {
  id: Generated<string>;
  tenant_id: string;
  version_id: string;
  document_id: string;
  ordinal: number;
  heading: string | null;
  content: string;
  /** vector(1536): written with `pgvector`'s `toSql`, read back as its text form. */
  embedding: ColumnType<string, string, string>;
  embedding_model: string;
  /** Generated tsvector; never written. */
  search: ColumnType<string, never, never>;
  created_at: GeneratedTimestamp;
}

export type AiStopReason = `handoff:${string}` | 'agent_replied' | 'taken_over';
export type AiAwaiting = 'order_number' | 'other';

export interface AiTicketStateTable {
  tenant_id: string;
  ticket_id: string;
  stopped_reason: AiStopReason | null;
  taken_over_by: string | null;
  agent_replied_at: Timestamp | null;
  awaiting: AiAwaiting | null;
  unresolved_turns: Generated<number>;
  summary: string | null;
  summary_upto_message_id: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AiTurnOutcome = 'replied' | 'drafted' | 'handoff' | 'skipped';

export interface AiTurnsTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  trigger_message_id: string;
  outcome: AiTurnOutcome;
  level: AiModelLevel | null;
  complexity_score: NullableNumeric;
  message_id: string | null;
  draft_id: string | null;
  created_at: GeneratedTimestamp;
}

export type AiDraftStatus = 'open' | 'sent' | 'discarded' | 'superseded';

export interface AiDraftsTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  turn_id: string;
  body: string;
  status: Generated<AiDraftStatus>;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AiRunPurpose = 'routing' | 'complexity' | 'reply' | 'draft' | 'summary' | 'embedding' | 'connection_test';
export type AiRunOutcome = 'ok' | 'auth' | 'credit' | 'rate_limit' | 'timeout' | 'unavailable' | 'bad_request';

/** One provider call; never holds message content (FR-021). */
export interface AiRunsTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string | null;
  turn_id: string | null;
  purpose: AiRunPurpose;
  provider: string;
  model: string;
  level: AiModelLevel | null;
  complexity_score: NullableNumeric;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cost_usd: NullableNumeric;
  cost_estimated: Generated<boolean>;
  duration_ms: number;
  outcome: AiRunOutcome;
  created_at: GeneratedTimestamp;
}

export interface AiTables {
  ai_settings: AiSettingsTable;
  ai_store_connections: AiStoreConnectionsTable;
  ai_complexity_factors: AiComplexityFactorsTable;
  ai_policy_documents: AiPolicyDocumentsTable;
  ai_policy_versions: AiPolicyVersionsTable;
  ai_policy_chunks: AiPolicyChunksTable;
  ai_ticket_state: AiTicketStateTable;
  ai_turns: AiTurnsTable;
  ai_drafts: AiDraftsTable;
  ai_runs: AiRunsTable;
}
