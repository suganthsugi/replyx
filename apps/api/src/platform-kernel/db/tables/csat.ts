import type { Generated, GeneratedTimestamp, Timestamp } from './column-types.js';

/** Migration 0020_csat (data-model.md "csat_ratings"). */

export interface CsatRatingsTable {
  id: Generated<string>;
  tenant_id: string;
  ticket_id: string;
  customer_id: string;
  /** 1–5; `null` while skipped. */
  score: number | null;
  comment: string | null;
  skipped_at: Timestamp | null;
  rated_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CsatTables {
  csat_ratings: CsatRatingsTable;
}
