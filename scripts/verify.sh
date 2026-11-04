#!/usr/bin/env bash
# Gate for every commit: exits non-zero if ANY check fails. Prints a one-line summary per check.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=$(mktemp -d); fail=0
check() { local name=$1; shift; if "$@" >"$OUT/$name.log" 2>&1; then echo "ok    $name"; else echo "FAIL  $name  (see $OUT/$name.log)"; fail=1; fi; }

db_suite() { tests/apply.sh >"$OUT/db.txt" 2>&1; ! grep -qE 'FAIL|ERROR' "$OUT/db.txt" && grep -q '^PASS' "$OUT/db.txt"; }
check prisma-validate env DATABASE_URL=postgresql://x@l/x DIRECT_URL=postgresql://x@l/x npx prisma validate
check prisma-generate npx prisma generate
check schema-drift scripts/drift.sh
check db-suite db_suite
check packages pnpm -r --filter "./packages/*" test
check api-typecheck bash -c 'cd apps/api && npx tsc -p . --noEmit'
check api-e2e bash -c 'cd apps/api && npx vitest run'
check web-build bash -c 'cd apps/web && NEXT_TELEMETRY_DISABLED=1 npx next build'
echo "db suite: $(grep -c '^PASS' "$OUT/db.txt" 2>/dev/null) PASS; api: $(grep -oE 'Tests +[0-9]+ passed' "$OUT/api-e2e.log" | tail -1)"
exit $fail
