#!/usr/bin/env bash
# Build a local database for the API: migrations + seed + RLS, the API login
# role, and (optionally) demo fixtures.
#   scripts/dev-db.sh [dbname] [--fixtures]
# Needs a Postgres superuser: the local `postgres` OS user, or PGHOST/PGUSER/PGPASSWORD (CI).
set -euo pipefail
DB=${1:-herp_dev}
cd "$(dirname "$0")/.."
source scripts/pg.sh
psql_() { pg_admin -q -v ON_ERROR_STOP=1 -d "$DB"; }
pg_admin -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" 2>&1 | grep -v NOTICE || true
for f in prisma/migrations/*/migration.sql prisma/seed.sql prisma/rls.sql; do psql_ < "$f" 2>&1 | grep -vE 'NOTICE|^$' || true; done

# The API logs in as herp_api: LOGIN, no BYPASSRLS, no table privileges of its
# own. It can only act by SET ROLE app_user inside a request transaction.
psql_ <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'herp_api') THEN
    CREATE ROLE herp_api LOGIN PASSWORD 'herp_api_dev' NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
GRANT app_user TO herp_api;
-- Background worker (OCR, reminders, key provisioning): acts only via SET ROLE app_service (BYPASSRLS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'herp_worker') THEN
    CREATE ROLE herp_worker LOGIN PASSWORD 'herp_worker_dev' NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
GRANT app_service TO herp_worker;
SQL
[[ " $* " == *" --fixtures "* ]] && psql_ < scripts/dev-fixtures.sql
echo "ready: api    postgresql://herp_api:herp_api_dev@localhost:5432/$DB"
echo "       worker postgresql://herp_worker:herp_worker_dev@localhost:5432/$DB"
