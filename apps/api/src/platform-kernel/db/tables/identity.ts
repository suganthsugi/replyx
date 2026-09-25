import type { Generated, GeneratedTimestamp, JsonValue, Timestamp } from './column-types.js';

/** Global (no RLS, `replyx_platform` only). Migration 0003_identity. */
export interface PlatformOperatorsTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  status: Generated<'active' | 'deactivated'>;
  last_sign_in_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Global (no RLS, `replyx_platform` only). `token_hash` is the SHA-256 of the cookie token. */
export interface OperatorSessionsTable {
  id: Generated<string>;
  operator_id: string;
  token_hash: Buffer;
  last_seen_at: GeneratedTimestamp;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
  created_at: GeneratedTimestamp;
}

export type UserStatus = 'invited' | 'active' | 'deactivated';
export type UserKind = 'staff' | 'customer';
export type Availability = 'online' | 'away' | 'offline';

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  name: string;
  avatar_attachment_id: string | null;
  password_hash: string | null;
  status: Generated<UserStatus>;
  kind: UserKind;
  availability: Generated<Availability>;
  time_display: Generated<JsonValue>;
  failed_sign_ins: Generated<number>;
  locked_until: Timestamp | null;
  last_sign_in_at: Timestamp | null;
  erased_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** `token_hash` is the SHA-256 of the `rx_session` cookie token (research D5). */
export interface SessionsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: Buffer;
  kind: UserKind;
  trusted_device: Generated<boolean>;
  last_seen_at: GeneratedTimestamp;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
  created_at: GeneratedTimestamp;
}

/** Migration 0006_identity_flows. One pending invitation per `(tenant_id, email)`. */
export interface UserInvitationsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  email: string;
  role_ids: string[];
  invited_by: string | null;
  token_hash: Buffer;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

/** Customer sign-in links (FR-012): single use, 15 minutes, superseded by a newer link. */
export interface SignInLinksTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  superseded_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface PasswordResetsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

/** Customers only; `notes` is staff-only. */
export interface CustomerProfilesTable {
  user_id: string;
  tenant_id: string;
  phone: string | null;
  company: string | null;
  notes: string | null;
  last_message_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IdentityTables {
  platform_operators: PlatformOperatorsTable;
  operator_sessions: OperatorSessionsTable;
  users: UsersTable;
  sessions: SessionsTable;
  user_invitations: UserInvitationsTable;
  sign_in_links: SignInLinksTable;
  password_resets: PasswordResetsTable;
  customer_profiles: CustomerProfilesTable;
}
