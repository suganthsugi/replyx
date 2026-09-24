import type { ColumnType, Generated, JsonValue, Timestamp } from './column-types.js';

/** Global (no RLS). Migration 0002_tenancy. */
export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<'active' | 'suspended'>;
  /** bigint: pg returns it as a string. */
  access_version: Generated<string>;
  suspended_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface TenantCountersTable {
  tenant_id: string;
  name: string;
  /** bigint: pg returns it as a string. */
  value: ColumnType<string, number | string, number | string>;
}

export interface TenancyTables {
  tenants: TenantsTable;
  tenant_settings: TenantSettingsTable;
  tenant_counters: TenantCountersTable;
}
