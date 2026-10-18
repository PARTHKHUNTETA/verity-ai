-- Least-privilege database roles for VerityAI (docs/system-design.md §7).
-- Run ONCE per database as a superuser (e.g. the `postgres` user of a managed Postgres):
--
--   psql "$SUPERUSER_DATABASE_URL" -v migrator_password="'…'" -v app_password="'…'" -f deploy/db-roles.sql
--
--   verity_migrator  owns the schema: runs migrations, installs the job queue, creates trace
--                    partitions (npm run db:setup, and the worker's partition maintenance).
--   verity_app       what the API and the worker use day to day: read and write rows, nothing else.
--                    It cannot create, alter or drop tables, so an SQL injection or a bug in
--                    the app can't change the schema.

CREATE ROLE verity_migrator LOGIN PASSWORD :migrator_password;
CREATE ROLE verity_app LOGIN PASSWORD :app_password;

-- Extensions need a superuser, so they are created here instead of in a migration's role.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO verity_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO verity_app', current_database());
END $$;

-- The migrator owns everything in public (Postgres 15+ no longer lets every role create there).
ALTER SCHEMA public OWNER TO verity_migrator;
GRANT USAGE ON SCHEMA public TO verity_app;

-- Every table, sequence and function the migrator creates later is usable by the app (rows only).
-- pg-boss creates its own schema ("pgboss") on first setup; the same rules apply there.
ALTER DEFAULT PRIVILEGES FOR ROLE verity_migrator
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO verity_app;
ALTER DEFAULT PRIVILEGES FOR ROLE verity_migrator
  GRANT USAGE, SELECT ON SEQUENCES TO verity_app;
ALTER DEFAULT PRIVILEGES FOR ROLE verity_migrator
  GRANT EXECUTE ON FUNCTIONS TO verity_app;
