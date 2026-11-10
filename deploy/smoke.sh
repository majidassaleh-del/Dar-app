#!/usr/bin/env bash
# Post-start checks (docs/04-go-live.md §3.4 and check B). Read-only: creates nothing.
#   deploy/smoke.sh darerp.net
set -uo pipefail
d=${1:?domain, e.g. darerp.net}; fail=0
check() { local name=$1 want=$2 got=$3; if [ "$got" = "$want" ]; then echo "ok    $name ($got)"; else echo "FAIL  $name: got '$got', want '$want'"; fail=1; fi; }
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@"; }
check "API health"                              200 "$(code https://api.$d/v1/health)"
check "API without a session"                   401 "$(code https://api.$d/v1/me)"
check "create-household without a key"          403 "$(code -X POST https://api.$d/v1/operator/create-household -H 'Content-Type: application/json' -d '{}')"
check "made-up invitation"                      403 "$(code -X POST https://api.$d/v1/auth/invitations/accept -H 'Content-Type: application/json' -d '{"token":"not-a-real-invitation-token-0000000000"}')"
check "CORS allows the app origin"              "https://app.$d" "$(curl -s -m 15 -o /dev/null -D - -X OPTIONS https://api.$d/v1/me -H "Origin: https://app.$d" -H 'Access-Control-Request-Method: GET' | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
check "CORS ignores a foreign origin"           "" "$(curl -s -m 15 -o /dev/null -D - -X OPTIONS https://api.$d/v1/me -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
check "landing page"                            200 "$(code https://$d/ar)"
check "workspace page, signed out → sign-in"    "https://$d/ar/sign-in" "$(curl -s -o /dev/null -m 15 -w '%{redirect_url}' https://$d/ar/staff)"
check "http → https"                            "https://$d/ar" "$(curl -s -o /dev/null -m 15 -w '%{redirect_url}' http://$d/ar)"
check "HSTS header"                             1 "$(curl -s -m 15 -o /dev/null -D - https://$d/ar | grep -ci '^strict-transport-security')"
exit $fail
