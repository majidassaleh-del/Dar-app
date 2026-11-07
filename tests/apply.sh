#!/usr/bin/env bash
# Rebuild a scratch database from migrations + seed + RLS, then run the RLS suite.
# Usage: tests/apply.sh [dbname]   (needs a Postgres superuser: local `su postgres`, or PGHOST/PGUSER/PGPASSWORD)
set -euo pipefail
DB=${1:-herp}
cd "$(dirname "$0")/.."
source scripts/pg.sh
psql_() { pg_admin -q -v ON_ERROR_STOP=1 -d "$DB"; }
pg_admin -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
for f in prisma/migrations/*/migration.sql prisma/seed.sql prisma/rls.sql; do
  echo "== $f"
  psql_ < "$f" 2>&1 | grep -vE 'NOTICE|^$' || true
done
echo "== tests/rls_test.sql"
psql_ < tests/rls_test.sql 2>&1 | sed -n 's/.*NOTICE:  //p; /ERROR/p'
