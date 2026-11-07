#!/usr/bin/env bash
# Fails if a database built from prisma/migrations differs from prisma/schema.prisma.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/pg.sh
pg_admin -q -d postgres -c 'DROP DATABASE IF EXISTS drift' -c 'CREATE DATABASE drift' >/dev/null 2>&1 || { echo "cannot create the drift database"; exit 1; }
for f in prisma/migrations/*/migration.sql; do pg_admin -q -v ON_ERROR_STOP=1 -d drift < "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 1; }; done
URL=$(pg_admin_url drift)
D=$(npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -v '^--' | grep -v '^$')
pg_admin_url_cleanup
pg_admin -q -d postgres -c 'DROP DATABASE drift' >/dev/null 2>&1
if [ -n "$D" ]; then echo "$D"; exit 1; fi
