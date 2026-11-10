#!/usr/bin/env bash
# Provision a household and its owner through the operator endpoint, then its encryption key.
# Run on the server, from the repository root:
#   deploy/create-household.sh <slug> "<Arabic name>" "<English name>" <owner phone +9665...> [owner e-mail] ["owner name"]
# The operator key is read without echo (or from OPERATOR_KEY); it is not written anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ENV_FILE:-.env.production}
[ $# -ge 4 ] || { sed -n 2,5p "$0"; exit 1; }
slug=$1 name_ar=$2 name_en=$3 phone=$4 email=${5:-} owner=${6:-}
domain=$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)
api=${API_URL:-https://api.$domain}
[ -n "${OPERATOR_KEY:-}" ] || { read -r -s -p "Operator key: " OPERATOR_KEY; echo; }
json() { python3 -c 'import json, sys
s, ar, en, p, e, o = sys.argv[1:7]
d = {"slug": s, "name": {"ar": ar, "en": en}, "locale": "ar", "owner": {"phone": p}}
if e: d["owner"]["email"] = e
if o: d["owner"]["name"] = {"ar": o}
print(json.dumps(d, ensure_ascii=False))' "$@"; }
body=$(json "$slug" "$name_ar" "$name_en" "$phone" "$email" "$owner")
echo "POST $api/v1/operator/create-household"
out=$(curl -sS -w '\n%{http_code}' -X POST "$api/v1/operator/create-household" -H "X-Operator-Key: $OPERATOR_KEY" -H 'Content-Type: application/json' --data "$body")
code=${out##*$'\n'}; echo "${out%$'\n'*}"; echo "HTTP $code"
[ "$code" = 201 ] || { echo "not created" >&2; exit 1; }
echo "== encryption key for the new household"
docker compose --env-file "$ENV_FILE" run --rm worker keys:provision
if grep -qE '^COMPOSE_PROFILES=.*tunnel' "$ENV_FILE"; then echo "== $slug.$domain is served already (the tunnel's wildcard hostname)"
else echo "== next: add  $slug.$domain  to TENANT_HOSTS in $ENV_FILE (DNS record first), then: docker compose --env-file $ENV_FILE up -d caddy"; fi
