import type { ColumnType, Generated, GeneratedTimestamp, JsonValue, Timestamp } from './column-types.js';

/** Global (no RLS). Migration 0002_tenancy. */
export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<'active' | 'suspended'>;
  /** bigint: pg returns it as a string. */
  access_version: Generated<string>;
  suspended_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantSettingsTable {
  tenant_id: string;
  logo_attachment_id: string | null;
  brand_colors: Generated<JsonValue>;
  welcome_message: string | null;
  timezone: Generated<string>;
  self_registration: Generated<boolean>;
  grace_period_hours: Generated<number>;
  after_close_behavior: Generated<'new_follow_up' | 'reopen_previous'>;
  offline_customer_notification: Generated<'email' | 'off'>;
  out_of_hours_message: string | null;
  retention_period: Generated<string>;
  audit_retention: Generated<string>;
  notification_defaults: Generated<JsonValue>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantCountersTable {
  tenant_id: string;
  name: string;
  /** bigint: pg returns it as a string. */
  value: ColumnType<string, number | string, number | string>;
}

/**
 * Migration 0007_support_access. A grant is active while `revoked_at IS NULL` and now is between
 * `starts_at` and `expires_at`; the window is at most 7 days (CHECK, FR-001a).
 */
export interface SupportAccessGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  granted_by: string;
  reason: string | null;
  starts_at: GeneratedTimestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
  created_at: GeneratedTimestamp;
}

export interface TenancyTables {
  tenants: TenantsTable;
  tenant_settings: TenantSettingsTable;
  tenant_counters: TenantCountersTable;
  support_access_grants: SupportAccessGrantsTable;
}
