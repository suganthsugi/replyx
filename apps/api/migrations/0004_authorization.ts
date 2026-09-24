import { sql, type Kysely } from 'kysely';

/**
 * Authorization tables (data-model.md "Authorization", research D6).
 *
 * `permission_definitions` is global: synced from code by the registry (T029) through the
 * platform pool; the app role only reads it. Everything else is tenant-owned with composite
 * foreign keys and forced RLS. `role_group_access.group_id IS NULL` is the built-in Ungrouped
 * entry, so its foreign key is only checked when a group is set.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE permission_definitions (
      key text PRIMARY KEY,
      resource text NOT NULL,
      action text NOT NULL,
      module text NOT NULL,
      description text NOT NULL,
      introduced_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT permission_definitions_key_format CHECK (key = resource || '.' || action),
      CONSTRAINT permission_definitions_resource_format CHECK (resource ~ '^[a-z][a-z_]*$'),
      CONSTRAINT permission_definitions_action_format CHECK (action ~ '^[a-z][a-z_]*$')
    )
  `.execute(db);
  await sql`SELECT grant_platform_dml('permission_definitions', ARRAY['SELECT', 'INSERT', 'UPDATE'])`.execute(db);
  await sql`GRANT SELECT ON permission_definitions TO replyx_app`.execute(db);

  await sql`
    CREATE TABLE roles (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      description text,
      system_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT roles_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT roles_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
      CONSTRAINT roles_description_length CHECK (char_length(description) <= 300),
      CONSTRAINT roles_system_key CHECK (system_key IN ('customer', 'agent', 'manager', 'admin'))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX roles_tenant_name ON roles (tenant_id, lower(name))`.execute(db);
  await sql`
    CREATE UNIQUE INDEX roles_tenant_system_key ON roles (tenant_id, system_key)
    WHERE system_key IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TRIGGER roles_touch BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  // FR-019: system roles can't be deleted or renamed (the service checks first; this is the backstop).
  await sql`
    CREATE FUNCTION roles_protect_system() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.system_key IS NOT NULL AND (
        TG_OP = 'DELETE'
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.system_key IS DISTINCT FROM OLD.system_key
      ) THEN
        RAISE EXCEPTION 'system role % cannot be deleted or renamed', OLD.system_key
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER roles_protect_system BEFORE UPDATE OR DELETE ON roles
    FOR EACH ROW EXECUTE FUNCTION roles_protect_system()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('roles')`.execute(db);
  await sql`SELECT grant_app_dml('roles')`.execute(db);

  await sql`
    CREATE TABLE role_permissions (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      role_id uuid NOT NULL,
      permission_key text NOT NULL REFERENCES permission_definitions (key),
      scope text NOT NULL DEFAULT 'tenant',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, role_id, permission_key),
      CONSTRAINT role_permissions_role_fk FOREIGN KEY (tenant_id, role_id)
        REFERENCES roles (tenant_id, id) ON DELETE CASCADE,
      -- FR-027: 'own' / 'assigned' are future scope values.
      CONSTRAINT role_permissions_scope CHECK (scope IN ('tenant'))
    )
  `.execute(db);
  await sql`SELECT enable_tenant_rls('role_permissions')`.execute(db);
  await sql`SELECT grant_app_dml('role_permissions')`.execute(db);

  // FR-020: a role with members can't be deleted (ON DELETE RESTRICT).
  await sql`
    CREATE TABLE user_roles (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      user_id uuid NOT NULL,
      role_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id, role_id),
      CONSTRAINT user_roles_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT user_roles_role_fk FOREIGN KEY (tenant_id, role_id)
        REFERENCES roles (tenant_id, id) ON DELETE RESTRICT
    )
  `.execute(db);
  await sql`CREATE INDEX user_roles_tenant_role ON user_roles (tenant_id, role_id)`.execute(db);
  await sql`SELECT enable_tenant_rls('user_roles')`.execute(db);
  await sql`SELECT grant_app_dml('user_roles')`.execute(db);

  await sql`
    CREATE TABLE groups (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      name text NOT NULL,
      description text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT groups_tenant_id_id_key UNIQUE (tenant_id, id),
      CONSTRAINT groups_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
      CONSTRAINT groups_description_length CHECK (char_length(description) <= 300),
      CONSTRAINT groups_status CHECK (status IN ('active', 'inactive'))
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX groups_tenant_name ON groups (tenant_id, lower(name))`.execute(db);
  await sql`
    CREATE TRIGGER groups_touch BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('groups')`.execute(db);
  await sql`SELECT grant_app_dml('groups')`.execute(db);

  await sql`
    CREATE TABLE role_group_access (
      tenant_id uuid NOT NULL REFERENCES tenants (id),
      role_id uuid NOT NULL,
      group_id uuid,
      can_view boolean NOT NULL DEFAULT false,
      can_create boolean NOT NULL DEFAULT false,
      can_edit boolean NOT NULL DEFAULT false,
      can_delete boolean NOT NULL DEFAULT false,
      scope text NOT NULL DEFAULT 'group',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT role_group_access_role_fk FOREIGN KEY (tenant_id, role_id)
        REFERENCES roles (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT role_group_access_group_fk FOREIGN KEY (tenant_id, group_id)
        REFERENCES groups (tenant_id, id) ON DELETE CASCADE,
      -- FR-027: 'assigned' / 'own' are future scope values.
      CONSTRAINT role_group_access_scope CHECK (scope IN ('group'))
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX role_group_access_role_group ON role_group_access
      (tenant_id, role_id, COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid))
  `.execute(db);
  await sql`CREATE INDEX role_group_access_tenant_group ON role_group_access (tenant_id, group_id)`.execute(db);
  await sql`
    CREATE TRIGGER role_group_access_touch BEFORE UPDATE ON role_group_access
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
  `.execute(db);
  await sql`SELECT enable_tenant_rls('role_group_access')`.execute(db);
  await sql`SELECT grant_app_dml('role_group_access')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE role_group_access`.execute(db);
  await sql`DROP TABLE groups`.execute(db);
  await sql`DROP TABLE user_roles`.execute(db);
  await sql`DROP TABLE role_permissions`.execute(db);
  await sql`DROP TABLE roles`.execute(db);
  await sql`DROP FUNCTION roles_protect_system()`.execute(db);
  await sql`DROP TABLE permission_definitions`.execute(db);
}
