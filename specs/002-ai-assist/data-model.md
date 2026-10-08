# Data Model: AI Assist

All tables are created in migration `0017_ai`. Every table has `tenant_id uuid not null` and `created_at` / `updated_at` where noted, and is set up with `enable_tenant_rls` and `grant_app_dml`. Ids are uuid v7, matching the existing tables.

## Changes to existing tables

| Table | Change |
|---|---|
| `ticket_messages` | `author_kind` check adds `'assistant'` (`author_id` null for assistant messages); `metadata jsonb null` with `{ handoff: true }` on the hand-off notice. A public non-hand-off assistant message updates `first_agent_reply_at`/`last_agent_reply_at`/`waiting_on` like a staff reply (FR-029). |
| `groups` | `ai_description text null` (≤ 500 chars). Only groups with a description are offered to AI routing. |
| `ticket_history` | New entry kinds `ai_routing` `{ groupId, confidence }`, `ai_handoff` `{ reason }`, `ai_takeover` `{ userId }`, `ai_handback` `{ userId }` (JSON payload; no schema change if `kind` is text, otherwise widen the check) |

## New tables

### `ai_settings` (1 row per tenant, created lazily)

| Column | Type | Notes |
|---|---|---|
| tenant_id | uuid PK | |
| reply_mode | text | `off` \| `drafts` \| `auto`, default `off` |
| routing_enabled | bool | default false |
| routing_threshold | numeric(3,2) | default 0.70, range 0.50–0.99 |
| models | jsonb | `{ fast, standard, advanced }`; each value must be in the catalog for that level |
| provider | text | `openrouter` (only value for now) |
| provider_key_sealed | text null | secret-box `v1:…` |
| provider_key_last4 | text null | |
| paused_reason | text null | `invalid_key` \| `no_credit` |
| paused_at | timestamptz null | |
| complexity_thresholds | jsonb | `{ standard: 0.45, advanced: 0.8 }`, with 0 < standard < advanced < 1 |
| updated_by, updated_at | | |

AI is **active** when `reply_mode ≠ off` or `routing_enabled`, a key is set, and `paused_reason` is null.

### `ai_store_connections` (≤ 1 per tenant)

| Column | Type | Notes |
|---|---|---|
| tenant_id | uuid PK | |
| kind | text | `spree` |
| base_url | text | https URL that passed the outbound guard |
| api_key_sealed, api_key_last4 | text | |
| last_test_at, last_test_ok, last_test_error | | |

### `ai_complexity_factors`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| position | int | order shown and sent |
| kind | text | `noul` \| `choice` \| `score` \| `customer_tag` \| `reopen_count` \| `sla_breached` |
| key | text | `^[a-z][a-z0-9_]{0,39}$`, unique per tenant (used as the Jev question key) |
| label | text | shown to admins |
| definition | jsonb | noul `{ instructions, criteria: { true, false } }`; choice `{ instructions, options: [{ key, description, value 0..1 }] }` (2–8); score `{ instructions, levels: string[] }` (2–7); customer_tag `{ tagId }` |
| weight | numeric(4,2) | 0–10 |

The whole set is replaced with `PUT /ai/complexity` (one transaction): at most 12 factors, at least one with weight > 0.

### `ai_policy_documents`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| title | text | 1–200 chars, unique per tenant among non-deleted documents |
| active_version_id | uuid null | FK → `ai_policy_versions` |
| status | text | derived for the API: `processing` if the newest version is processing, `failed` if the newest failed and none is active, else `ready` |
| deleted_at | timestamptz null | soft delete; its chunks are hard-deleted in the same transaction |

### `ai_policy_versions`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| document_id | uuid FK | |
| source | text | `text` \| `file` |
| body | text null | for `text` (≤ 200 000 chars) |
| attachment_id | uuid null | for `file`; attachment must be `clean` |
| extracted_chars | int null | |
| status | text | `processing` → `active` \| `failed` \| `superseded` |
| error | text null | e.g. `no_extractable_text`, `blocked_by_scan`, `too_large` |
| created_by, created_at | | |

State: `processing → active` (in the same transaction, the previous active version becomes `superseded` and its chunks are deleted) or `processing → failed`. A newer version that is still processing never removes the active one.

### `ai_policy_chunks`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| version_id | uuid FK on delete cascade | |
| document_id | uuid | denormalised for filtering |
| ordinal | int | |
| heading | text null | nearest Markdown heading |
| content | text | about 3 200 chars |
| embedding | vector(1536) | HNSW `vector_cosine_ops` |
| embedding_model | text | e.g. `openai/text-embedding-3-small` |
| search | tsvector generated | `to_tsvector('replyx_search', coalesce(heading,'') || ' ' || content)`, GIN index |

Only chunks of `active` versions exist, so retrieval doesn't need to join on status.

### `ai_ticket_state` (1 per ticket, created on first AI activity)

| Column | Type | Notes |
|---|---|---|
| ticket_id | uuid PK | |
| stopped_reason | text null | `handoff:<reason>` \| `agent_replied` \| `taken_over` |
| taken_over_by | uuid null | user who pressed Take over |
| agent_replied_at | timestamptz null | set by the consumer of staff public `message.created` |
| awaiting | text null | `order_number` \| `other` |
| unresolved_turns | int | reset to 0 when a turn is resolved |
| summary | text null | summary of messages older than the last 20 |
| summary_upto_message_id | uuid null | |

Merge: the target ticket keeps its own state. Split: the new ticket starts with no state.

### `ai_turns` (idempotency and audit of each assistant turn)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ticket_id | uuid | |
| trigger_message_id | uuid | **UNIQUE (tenant_id, ticket_id, trigger_message_id)** |
| outcome | text | `replied` \| `drafted` \| `handoff` \| `skipped` |
| level | text | `fast` \| `standard` \| `advanced` |
| complexity_score | numeric(4,3) null | |
| message_id / draft_id | uuid null | the result |
| created_at | | |

### `ai_drafts`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ticket_id | uuid | partial unique index on (tenant_id, ticket_id) where `status='open'` |
| turn_id | uuid | |
| body | text | |
| status | text | `open` → `sent` \| `discarded` \| `superseded` |
| resolved_by, resolved_at | | |

### `ai_runs` (one per provider call; no message content)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| ticket_id | uuid null | |
| turn_id | uuid null | |
| purpose | text | `routing` \| `complexity` \| `reply` \| `draft` \| `summary` \| `embedding` \| `connection_test` |
| provider, model, level | text | |
| input_tokens, output_tokens | int | |
| cost_usd | numeric(12,6) null | from the provider when given, else estimated |
| cost_estimated | bool | |
| duration_ms | int | |
| outcome | text | `ok` \| `auth` \| `credit` \| `rate_limit` \| `timeout` \| `unavailable` \| `bad_request` |
| created_at | timestamptz | index (tenant_id, created_at desc) |

Retention: follows the tenant deletion cascade. No separate purge in this release.

## Domain events (outbox)

| Event | Payload | Consumers |
|---|---|---|
| `ai.policy_version_created` | `{ documentId, versionId }` | indexer job |
| `ai.policy_version_updated` | `{ documentId, versionId, status }` | realtime to admins (status chip) |
| `ai.draft_ready` | `{ ticketId, draftId }` | realtime to the ticket's staff room |
| `ai.paused` / `ai.resumed` | `{ reason? }` | notifications (holders of `ai_settings.manage`), realtime |
| `conversation.responder_changed` | `{ ticketId, customerId, responder }` | realtime to the ticket staff stream and the customer projection (badge) |
| `ai.responder_scope_changed` | `{}` | realtime: clients refetch the responder after a mode or pause change |
| existing `message.created` | `authorKind: 'assistant'` | customer projection, notifications (assistant messages notify nobody on staff), search index |

## Permissions (`ai` module)

| Key | Grants | Default roles |
|---|---|---|
| `ai_settings.manage` | AI settings, provider key, store connection, complexity, group AI descriptions | Admin |
| `ai_knowledge.manage` | policy documents and versions | Admin |
| `ai_usage.view` | the AI runs list | Admin |

Drafts are visible to anyone who can reply on the ticket (existing ticket edit access).

## Derived: responder (badge, FR-031)

```
responder = assistant  if settings.reply_mode = 'auto' and AI active and ticket state not stopped
          = agent      if ticket.owner_id is set (name, avatar)
          = team       otherwise
```
