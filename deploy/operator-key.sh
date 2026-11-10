#!/usr/bin/env bash
# Create an operator key (the key that may call POST /v1/operator/create-household) and register
# its SHA-256 in the database. The key is printed ONCE: store it in a password manager.
#   docker compose --env-file .env.production run --rm db deploy/operator-key.sh [label]
set -euo pipefail
: "${DB_OWNER_URL:?set DB_OWNER_URL}"
label=${1:-ops-$(date +%Y-%m)}
[[ "$label" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "label: letters, digits, dot, dash, underscore" >&2; exit 1; }
key=$(openssl rand -hex 32)
hash=$(printf %s "$key" | sha256sum | cut -d' ' -f1)
psql -X -q -v ON_ERROR_STOP=1 "$DB_OWNER_URL" -c "INSERT INTO app.operator_keys (hash, label) VALUES ('$hash', '$label')"
echo "operator key registered (label: $label). Shown once:"
echo
echo "  $key"
echo
