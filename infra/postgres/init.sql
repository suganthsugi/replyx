-- ---------------------------------------------------------------------------
-- infra/postgres/init.sql -- database roles and extensions (T013, research D3)
--
-- Roles
--   replyx_owner     Owns schema `public` and everything in it; runs migrations
--                    (DATABASE_URL_OWNER). No superuser, no BYPASSRLS: tenant
--                    tables use FORCE ROW LEVEL SECURITY (T017), so the owner is
--                    subject to the policies as well.
--   replyx_app       The API and worker role (DATABASE_URL_APP). NOSUPERUSER,
--                    NOBYPASSRLS, no CREATE anywhere, so it can never own a table
--                    and can never skip RLS. It gets DML per table only, through
--                    the migration GRANT helpers (T017). There are deliberately
--                    no blanket default privileges here.
--   replyx_platform  The platform console role (DATABASE_URL_PLATFORM). Same
--                    attributes as replyx_app. Migrations grant it DML on the
--                    global tables only (tenants, platform_operators,
--                    permission_definitions).
--
-- Passwords
--   Never hard-coded here. psql reads them from the environment of the process
--   that runs this file:
--     REPLYX_OWNER_PASSWORD, REPLYX_APP_PASSWORD, REPLYX_PLATFORM_PASSWORD
--   They must match the passwords in DATABASE_URL_OWNER / _APP / _PLATFORM
--   (.env.example dev defaults: replyx_owner_dev_password,
--   replyx_app_dev_password, replyx_platform_dev_password).
--
--   docker compose: mount this file at /docker-entrypoint-initdb.d/init.sql and
--   pass the three variables to the postgres service. The image runs it once,
--   as the superuser, against POSTGRES_DB, on the first start of an empty data
--   volume.
--
--   Anywhere else (Testcontainers, a manual rerun), pass psql variables instead:
--     psql -U postgres -d replyx -f init.sql \
--       -v replyx_owner_password=... -v replyx_app_password=... \
--       -v replyx_platform_password=...
--   An environment variable takes precedence over a -v value when both are set.
--
-- The script is idempotent: rerunning it resets role attributes and passwords
-- (this is also how to rotate a password) and never drops anything.
-- It requires psql 15+ (\getenv) and PostgreSQL 15+.
-- ---------------------------------------------------------------------------

-- Never echo statements: some of them carry passwords.
\set ECHO none
\set ECHO_HIDDEN off
\set QUIET on
\set ON_ERROR_STOP on

\getenv replyx_owner_password REPLYX_OWNER_PASSWORD
\getenv replyx_app_password REPLYX_APP_PASSWORD
\getenv replyx_platform_password REPLYX_PLATFORM_PASSWORD

-- Fail loudly when a password is missing or empty. The check never prints the
-- value.
\if :{?replyx_owner_password}
\else
  \set replyx_owner_password ''
\endif
\if :{?replyx_app_password}
\else
  \set replyx_app_password ''
\endif
\if :{?replyx_platform_password}
\else
  \set replyx_platform_password ''
\endif

SELECT :'replyx_owner_password' = '' AS owner_pw_missing,
       :'replyx_app_password' = '' AS app_pw_missing,
       :'replyx_platform_password' = '' AS platform_pw_missing
\gset

\if :owner_pw_missing
  DO $$ BEGIN RAISE EXCEPTION 'init.sql: REPLYX_OWNER_PASSWORD (or -v replyx_owner_password) is not set'; END $$;
\endif
\if :app_pw_missing
  DO $$ BEGIN RAISE EXCEPTION 'init.sql: REPLYX_APP_PASSWORD (or -v replyx_app_password) is not set'; END $$;
\endif
\if :platform_pw_missing
  DO $$ BEGIN RAISE EXCEPTION 'init.sql: REPLYX_PLATFORM_PASSWORD (or -v replyx_platform_password) is not set'; END $$;
\endif

BEGIN;

-- ---------------------------------------------------------------------------
-- Roles (create if missing, then force the attributes on every run)
-- ---------------------------------------------------------------------------
SELECT 'CREATE ROLE replyx_owner'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replyx_owner') \gexec
SELECT 'CREATE ROLE replyx_app'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replyx_app') \gexec
SELECT 'CREATE ROLE replyx_platform'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replyx_platform') \gexec

ALTER ROLE replyx_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'replyx_owner_password';
ALTER ROLE replyx_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'replyx_app_password';
ALTER ROLE replyx_platform WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'replyx_platform_password';

-- RLS must filter rows for the runtime roles, never be switched off.
ALTER ROLE replyx_app SET row_security = on;
ALTER ROLE replyx_platform SET row_security = on;

-- ---------------------------------------------------------------------------
-- Database: only the three roles (and the superuser) may connect.
-- ---------------------------------------------------------------------------
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"DBNAME" TO replyx_owner;
GRANT CONNECT ON DATABASE :"DBNAME" TO replyx_app, replyx_platform;

-- ---------------------------------------------------------------------------
-- Schema: replyx_owner owns `public`; the runtime roles can only use it.
-- ---------------------------------------------------------------------------
ALTER SCHEMA public OWNER TO replyx_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO replyx_app, replyx_platform;

-- ---------------------------------------------------------------------------
-- Extensions (created by the superuser, in `public`)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Self-check: stop the init if the runtime roles could ever bypass RLS or own
-- or create objects.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['replyx_app', 'replyx_platform'] LOOP
    IF EXISTS (SELECT FROM pg_roles
                WHERE rolname = r
                  AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
      RAISE EXCEPTION 'init.sql: role % has a privileged attribute', r;
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = r::regrole) THEN
      RAISE EXCEPTION 'init.sql: role % must not be a member of any role', r;
    END IF;
    IF EXISTS (SELECT FROM pg_class WHERE relowner = r::regrole)
       OR EXISTS (SELECT FROM pg_namespace WHERE nspowner = r::regrole) THEN
      RAISE EXCEPTION 'init.sql: role % owns objects', r;
    END IF;
    IF has_schema_privilege(r, 'public', 'CREATE')
       OR has_database_privilege(r, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'init.sql: role % can create objects', r;
    END IF;
  END LOOP;
END
$$;

COMMIT;

\unset replyx_owner_password
\unset replyx_app_password
\unset replyx_platform_password
