import type { Generated, GeneratedTimestamp, JsonValue } from './column-types.js';

/** Migration 0009_tags_views (data-model.md "tags, ticket_tags, customer_tags", "views"). */

export interface TagsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Pure join table: no `updated_at`, same shape as `user_roles`. */
export interface TicketTagsTable {
  tenant_id: string;
  ticket_id: string;
  tag_id: string;
  created_at: GeneratedTimestamp;
}

/** Pure join table: no `updated_at`, same shape as `user_roles`. */
export interface CustomerTagsTable {
  tenant_id: string;
  user_id: string;
  tag_id: string;
  created_at: GeneratedTimestamp;
}

export type ViewVisibility = 'personal' | 'all_staff' | 'roles' | 'groups';

/** `owner_id` is set only when `visibility = 'personal'`. */
export interface ViewsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  system_key: string | null;
  owner_id: string | null;
  visibility: ViewVisibility;
  shared_role_ids: Generated<string[]>;
  shared_group_ids: Generated<string[]>;
  conditions: Generated<JsonValue>;
  sort: Generated<JsonValue>;
  columns: Generated<string[]>;
  position: Generated<number>;
  hidden: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TagsViewsTables {
  tags: TagsTable;
  ticket_tags: TicketTagsTable;
  customer_tags: CustomerTagsTable;
  views: ViewsTable;
}
