#!/usr/bin/env bash
# Fails if a database built from prisma/migrations differs from prisma/schema.prisma.
set -uo pipefail
cd "$(dirname "$0")/.."
su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'localpg'\" -c 'DROP DATABASE IF EXISTS drift' -c 'CREATE DATABASE drift'" >/dev/null 2>&1
for f in prisma/migrations/*/migration.sql; do su postgres -c "psql -q -v ON_ERROR_STOP=1 -d drift" < "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 1; }; done
D=$(npx prisma migrate diff --from-url "postgresql://postgres:localpg@localhost:5432/drift" --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -v '^--' | grep -v '^$')
su postgres -c "psql -qc 'ALTER USER postgres PASSWORD NULL' -c 'DROP DATABASE drift'" >/dev/null 2>&1
if [ -n "$D" ]; then echo "$D"; exit 1; fi
