import type { Generated, Timestamp } from './column-types.js';

/** Global (no RLS). Synced from code by the permission registry. Migration 0004_authorization. */
export interface PermissionDefinitionsTable {
  key: string;
  resource: string;
  action: string;
  module: string;
  description: string;
  introduced_at: Generated<Timestamp>;
}

export type SystemRoleKey = 'customer' | 'agent' | 'manager' | 'admin';

export interface RolesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  system_key: SystemRoleKey | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface RolePermissionsTable {
  tenant_id: string;
  role_id: string;
  permission_key: string;
  scope: Generated<'tenant'>;
  created_at: Generated<Timestamp>;
}

export interface UserRolesTable {
  tenant_id: string;
  user_id: string;
  role_id: string;
  created_at: Generated<Timestamp>;
}

export interface GroupsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  status: Generated<'active' | 'inactive'>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

/** `group_id: null` is the built-in Ungrouped entry. */
export interface RoleGroupAccessTable {
  tenant_id: string;
  role_id: string;
  group_id: string | null;
  can_view: Generated<boolean>;
  can_create: Generated<boolean>;
  can_edit: Generated<boolean>;
  can_delete: Generated<boolean>;
  scope: Generated<'group'>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AuthorizationTables {
  permission_definitions: PermissionDefinitionsTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  groups: GroupsTable;
  role_group_access: RoleGroupAccessTable;
}
