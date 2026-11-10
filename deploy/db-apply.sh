#!/usr/bin/env bash
# Bring a database to the current schema and security rules. Safe to run again: use it for the
# first setup and after every upgrade.
#
#   DB_OWNER_URL=postgresql://<owner>@<host>:5432/<db>  \
#   HERP_API_DB_PASSWORD=...  HERP_WORKER_DB_PASSWORD=...  deploy/db-apply.sh
#
# DB_OWNER_URL  a role that owns the schema and is exempt from row-level security (superuser, or
#               BYPASSRLS + CREATEROLE). Used only here, never by the running services.
#               Supabase: use the DIRECT connection (port 5432), not the transaction pooler.
# It then:  1. applies the migrations not applied yet (each in its own transaction, recorded
#              in app.applied_migrations);
#           2. loads the permission catalogue and role templates (prisma/seed.sql);
#           3. re-installs every policy, trigger and function of prisma/rls.sql in ONE
#              transaction, so there is never a moment without the rules;
#           4. creates / updates the two login roles the services use:
#              herp_api    → may only act as app_user (subject to row-level security);
#              herp_worker → may only act as app_service (background jobs).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DB_OWNER_URL:?set DB_OWNER_URL}"
: "${HERP_API_DB_PASSWORD:?set HERP_API_DB_PASSWORD}"
: "${HERP_WORKER_DB_PASSWORD:?set HERP_WORKER_DB_PASSWORD}"
[ "${#HERP_API_DB_PASSWORD}" -ge 20 ] && [ "${#HERP_WORKER_DB_PASSWORD}" -ge 20 ] || { echo "the two database passwords need at least 20 characters" >&2; exit 1; }
PSQL=(psql -X -q -v ON_ERROR_STOP=1 "$DB_OWNER_URL")
say() { printf '== %s\n' "$*"; }

"${PSQL[@]}" <<'SQL'
DO $$ BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'connect as a role that is superuser or has BYPASSRLS (current: %)', current_user;
  END IF;
END $$;
SET client_min_messages = warning;
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.applied_migrations (name text PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now());
SQL

# A database built before this script existed (migrations applied by hand): record them once.
if [ "$("${PSQL[@]}" -At -c "SELECT (to_regclass('public.households') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.applied_migrations))")" = t ]; then
  : "${DB_BASELINE:?this database already has tables but no migration record. Set DB_BASELINE to the last migration it contains (e.g. 0016_custom_roles_email_invitations) and run again}"
  for d in prisma/migrations/*/; do n=$(basename "$d"); [[ "$n" > "$DB_BASELINE" ]] || "${PSQL[@]}" -c "INSERT INTO app.applied_migrations (name) VALUES ('$n') ON CONFLICT DO NOTHING"; done
  say "recorded migrations up to $DB_BASELINE as already applied"
fi

for d in prisma/migrations/*/; do
  n=$(basename "$d")
  if [ "$("${PSQL[@]}" -At -c "SELECT EXISTS (SELECT 1 FROM app.applied_migrations WHERE name = '$n')")" = f ]; then
    say "migration $n"
    { echo 'SET client_min_messages = warning;'; cat "$d/migration.sql"; echo "INSERT INTO app.applied_migrations (name) VALUES ('$n');"; } | "${PSQL[@]}" --single-transaction
  fi
done

# The API's functions compare e-mail addresses with citext operators resolved in "public".
where=$("${PSQL[@]}" -At -c "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'citext'")
[ "$where" = public ] || { echo "the citext extension is installed in schema \"$where\"; it must be in \"public\" (ALTER EXTENSION citext SET SCHEMA public)" >&2; exit 1; }

say "permission catalogue and role templates"
{ echo 'SET client_min_messages = warning;'; cat prisma/seed.sql; } | "${PSQL[@]}" --single-transaction

say "security rules (policies, triggers, functions)"
{
  cat <<'SQL'
SET client_min_messages = warning;
-- Remove what rls.sql creates without "OR REPLACE", then let it install everything again.
-- Same transaction: other sessions keep seeing the old rules until the new ones commit.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
  FOR r IN SELECT t.tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND NOT t.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.tgname, r.relname);
  END LOOP;
END $$;
SQL
  cat prisma/rls.sql
} | "${PSQL[@]}" --single-transaction

say "login roles"
"${PSQL[@]}" -v api_pw="$HERP_API_DB_PASSWORD" -v worker_pw="$HERP_WORKER_DB_PASSWORD" <<'SQL'
SET client_min_messages = warning;
SELECT format('CREATE ROLE %I LOGIN NOBYPASSRLS NOINHERIT', r) FROM unnest(ARRAY['herp_api', 'herp_worker']) r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE herp_api    WITH LOGIN NOBYPASSRLS NOINHERIT PASSWORD :'api_pw';
ALTER ROLE herp_worker WITH LOGIN NOBYPASSRLS NOINHERIT PASSWORD :'worker_pw';
GRANT app_user TO herp_api;
GRANT app_service TO herp_worker;
SQL

"${PSQL[@]}" -At <<'SQL'
SELECT format('ok: %s migrations, %s tables under row-level security, %s policies, operator keys on file: %s',
  (SELECT count(*) FROM app.applied_migrations),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity),
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  (SELECT count(*) FROM app.operator_keys));
SELECT 'WARNING: tables without forced row-level security: ' || string_agg(c.relname, ', ')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relforcerowsecurity HAVING count(*) > 0;
SQL
