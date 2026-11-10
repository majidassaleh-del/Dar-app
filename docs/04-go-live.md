# 04 · Go-live: execution and verification guide (`darerp.net`)

Run the parts in order. Every step has an expected result; **stop at the first one that does not match**. Nothing here has been executed against production. Placeholders are in `<angle brackets>`; never paste a real secret into a chat, a ticket or the repository.

Reference: `docs/03-deployment.md` (every variable), `docs/02-api.md` §2b (invitations) and §2c (operator provisioning, entries).

## 0. Before you start: open items

These are not covered by the four parts below and must be settled first. The API refuses to start in production without items 1–3.

| # | Item | Why it blocks |
|---|---|---|
| 1 | **Cloud KMS key** and the `@google-cloud/kms` package installed in the API image (`HERP_KMS=gcp`, `HERP_KMS_KEY`) | Production refuses `HERP_KMS=local`. The package is an optional dependency and is not installed by default |
| 2 | **SMS / e-mail gateway for the API's own codes** (`OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN`) | First-time setup sends its phone and e-mail codes through this gateway, separately from Supabase's sign-in code. Never tested against a live provider |
| 3 | **Supabase asymmetric signing keys** enabled, so that `https://<project>.supabase.co/auth/v1/.well-known/jwks.json` returns keys (`AUTH_JWKS_URL`) | Production accepts only asymmetric tokens |
| 4 | **Supabase phone provider** (SMS) and e-mail OTP enabled for existing users | Sign-in codes |
| 5 | **Where the API and web run** (no Dockerfile or deploy config is in the repository yet) and **which Postgres** (Cloud SQL or Supabase Postgres) | The deploy commands depend on it |
| 6 | **File storage**: uploads (salary transfer screenshots, documents) are written to local disk (`STORAGE_DIR`) | On a host without a persistent disk they are lost at every redeploy. Mount a persistent volume, or accept this for the smoke test only |
| 7 | A fresh production database is built **once** from `prisma/migrations/*`, then `prisma/seed.sql`, then `prisma/rls.sql`, by a role with `BYPASSRLS`. `rls.sql` is written for a fresh database | Re-applying `rls.sql` to a live database needs a migration procedure that does not exist yet. On Supabase Postgres, confirm in a staging project first that its `postgres` role may run `rls.sql` (it creates the roles `app_user` and `app_service`) |
| 8 | Two login roles, as in `scripts/dev-db.sh`, with **strong** passwords: `herp_api` (`GRANT app_user`) for `DATABASE_URL`, `herp_worker` (`GRANT app_service`) for `WORKER_DATABASE_URL` | The API must never connect as the database owner |

## 1. Operator key

The key lets its holder create households. Generate it on the operator's machine; only its SHA-256 goes to the database.

```bash
# 1.1 Generate (64 hex characters) and keep it in the operator's password manager / secret store.
OPKEY=$(openssl rand -hex 32)

# 1.2 Its hash. Only this value is sent to the database.
OPHASH=$(printf %s "$OPKEY" | sha256sum | cut -d' ' -f1)

# 1.3 Register it, connected as the database owner (not herp_api).
psql "<owner connection string>" -v ON_ERROR_STOP=1 \
  -c "INSERT INTO app.operator_keys (hash, label) VALUES ('$OPHASH', 'ops-$(date +%Y-%m)')"

# 1.4 Check: exactly one row, and the API's role cannot read the table.
psql "<owner connection string>" -c "SELECT label, \"createdAt\" FROM app.operator_keys"
psql "<herp_api connection string>" -c "SET ROLE app_user" -c "SELECT * FROM app.operator_keys"   # expect: permission denied
```

Expected: `INSERT 0 1`; one row listed; `permission denied for table operator_keys`.
To revoke a key: `DELETE FROM app.operator_keys WHERE label = '<label>'`. With no row, `create-household` answers 403 to everyone.

## 2. Supabase

### 2.1 Disable public sign-up

Dashboard → **Authentication → Sign In / Providers → "Allow new users to sign up": off**. Keep phone and e-mail sign-in enabled (item 4 above).

### 2.2 Keys

| Key | Goes to | Variable |
|---|---|---|
| Project URL + `/auth/v1` | API and web | `AUTH_ADMIN_URL` (API), `HERP_AUTH_URL` (web) |
| **service_role** key | **API only** | `AUTH_ADMIN_KEY` |
| anon / publishable key | web only | `HERP_AUTH_KEY` |
| JWKS URL, issuer, audience | API | `AUTH_JWKS_URL=https://<project>.supabase.co/auth/v1/.well-known/jwks.json`, `AUTH_ISSUER=https://<project>.supabase.co/auth/v1`, `AUTH_AUDIENCE=authenticated` |

The service-role key can create and read every identity. It is set on the API service only: never on the web app, never in a browser, never in the repository.

### 2.3 The two checks

Use a mobile number **nobody has invited**.

```bash
# Check A — the provider refuses to create a user.
curl -s -X POST "https://<project>.supabase.co/auth/v1/otp" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"phone":"+9665XXXXXXXX","create_user":true}'
# Expected: an error (4xx, "Signups not allowed"), and NO new row under Authentication → Users.

# Check B — the API refuses an invitation that does not exist (run after the API is up, part 4).
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.darerp.net/v1/auth/invitations/accept \
  -H "Content-Type: application/json" -d '{"token":"not-a-real-invitation-token-0000000000"}'
# Expected: 403
```

If check A creates a user: delete it in the dashboard, fix 2.1, repeat. Do not continue until it fails as expected.

## 3. Production settings

### 3.1 API (`api.darerp.net`)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_APP_URL` | `https://app.darerp.net` (invitation links are built from it) |
| `PUBLIC_API_URL` | `https://api.darerp.net` |
| `CORS_ORIGINS` | `https://darerp.net,https://app.darerp.net,https://*.darerp.net` |
| `TRUST_PROXY` | `1` (behind one load balancer) |
| `DATABASE_URL` | the `herp_api` login role |
| `DB_REQUEST_ROLE` | `app_user` |
| `WORKER_DATABASE_URL` | the `herp_worker` login role (worker jobs only) |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | from 2.2 |
| `AUTH_ADMIN_URL`, `AUTH_ADMIN_KEY` | from 2.2 |
| `AUTH_BRAND_NAME` | `Dar ERP` (or the product name you choose) |
| `HERP_KMS`, `HERP_KMS_KEY` | `gcp`, the Cloud KMS key resource name |
| `FILE_SIGNING_SECRET`, `OFFLINE_KEY_SECRET`, `SESSION_SIGNING_SECRET` | three different random values: `openssl rand -hex 32` each |
| `AUTH_TOTP_KEY` | `openssl rand -base64 32`. **Back it up**: losing it invalidates every authenticator enrolment |
| `OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN` | the SMS / e-mail gateway |
| `STORAGE_DIR` | a path on a persistent volume |

Rules the API enforces at start-up: `https` for both public URLs; no `*`, no `http://` and no TLD wildcard in `CORS_ORIGINS`; `AUTH_ADMIN_URL` and `AUTH_ADMIN_KEY` together. A violation stops the process with a message naming the variable.

### 3.2 Web (`darerp.net`, `app.darerp.net`, `*.darerp.net`)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HERP_API_URL` | `https://api.darerp.net` (or the internal service URL) |
| `HERP_AUTH_URL`, `HERP_AUTH_KEY` | from 2.2 (anon key) |
| `HERP_SESSION_COOKIE` | `__Secure-herp_session` |
| `HERP_COOKIE_DOMAIN` | `.darerp.net` |
| `HERP_TENANT_BASE_DOMAIN` | `darerp.net` |
| `HERP_TENANT_RESERVED` | `app,www,api,admin,auth,static,cdn,mail,status` |

Leave `HERP_DEMO` and `HERP_DEV_TOKEN` unset.

### 3.3 DNS and TLS

- Apex and `*.darerp.net` → web. `api.darerp.net` → API. Certificates for the apex and the wildcard.
- The proxy in front of the web app preserves `Host` and sets `X-Forwarded-Proto`.

### 3.4 Checks once both services are up

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.darerp.net/v1/health                       # 200
curl -s -o /dev/null -w "%{http_code}\n" https://api.darerp.net/v1/me                           # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.darerp.net/v1/operator/create-household \
     -H "Content-Type: application/json" -d '{}'                                                # 403
curl -sI -X OPTIONS https://api.darerp.net/v1/me -H "Origin: https://app.darerp.net" \
     -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin              # https://app.darerp.net
curl -sI -X OPTIONS https://api.darerp.net/v1/me -H "Origin: https://evil.example" \
     -H "Access-Control-Request-Method: GET" | grep -ci access-control-allow-origin             # 0
curl -s -o /dev/null -w "%{http_code}\n" https://darerp.net/ar                                  # 200 (landing page)
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://darerp.net/ar/staff            # a redirect (3xx) to /ar/sign-in
```

Then run check B from 2.3.

## 4. Live smoke test

Two people and two phones are needed: the **owner** and one **invited member**. Use real numbers that receive SMS. Record each result (pass / fail, time) as you go.

### 4.1 Provision the first household (operator)

```bash
curl -s -X POST https://api.darerp.net/v1/operator/create-household \
  -H "X-Operator-Key: $OPKEY" -H "Content-Type: application/json" \
  -d '{"slug":"<slug>","name":{"ar":"<دار ...>","en":"<Dar ...>"},"locale":"ar",
       "owner":{"phone":"+9665XXXXXXXX","email":"<owner e-mail>","name":{"ar":"<owner name>"}}}'
```

| Check | Expected |
|---|---|
| Response | `201` with `householdId`, `slug`, `owner.existingAccount: false` |
| Same call again | `409` (slug taken) |
| Same call without the header | `403` |
| Supabase → Authentication → Users | exactly one new user, with the owner's phone |

Then provision the household's encryption key (needed before any identity number, IBAN or health record is stored; not needed for the invitation flow itself):

```bash
node dist/worker.js keys:provision        # on the API image, with WORKER_DATABASE_URL and the KMS settings
```

Expected: `provisioned keys for 1 household(s)`.

### 4.2 Owner's first sign-in

1. Open `https://darerp.net/ar`. Expected: the landing page with the owner entry, the member entry and the invitation field.
2. Owner entry → the owner's mobile number → the SMS code (sent by Supabase).
3. First-time setup: confirm the mobile number (code sent by the API's gateway, **naming the household**), confirm the e-mail (subject names the household), scan the QR in an authenticator app (the entry is labelled with the household's name), enter its code.
4. Wait for the next authenticator code and enter it.

| Check | Expected |
|---|---|
| After step 4 | the workspace opens; the header shows the household's name |
| Header | a "Members" link is present |
| Browser cookies | `__Secure-herp_session`: `HttpOnly`, `Secure`, domain `.darerp.net`, expires at 04:00 Riyadh |
| `https://<slug>.darerp.net/ar` | the same household, without signing in again |

### 4.3 Invite a member (owner)

1. Members → Invitations → enter the member's name and mobile number, role "Staff", 3 days → Create.
2. Copy the link (it disappears after two minutes) and send it to the member.

| Check | Expected |
|---|---|
| List | the invitation shows "Waiting" |
| Link | starts with `https://app.darerp.net/ar/invite/` |

### 4.4 Accept and first sign-in (member, on their own phone)

1. Open the link. Expected: the household's name, the role, the masked number, an "Accept" button.
2. Accept. Expected: the sign-in page with "Invitation accepted".
3. Sign in with the invited number, complete the first-time setup as in 4.2, enter the next authenticator code.

| Check | Expected |
|---|---|
| After step 3 | the workspace opens under the **inviting household's** name |
| Header | no "Members" link |
| Open the same invitation link again | "Access denied" |
| Owner's Members page | the member is "Active" with the role "Staff"; the invitation shows "Accepted" |
| Supabase → Users | exactly two users |

### 4.5 Negative checks

| # | Action | Expected |
|---|---|---|
| 1 | Landing page → paste a made-up invitation code | "Access denied" |
| 2 | Member entry → a number nobody invited | the same "we sent a code" screen; no SMS arrives; no new Supabase user |
| 3 | The member signs out, then signs in through the **owner** entry | refused: "This entry is for household owners"; no session |
| 4 | The member opens `https://app.darerp.net/ar/members` | "Only the household owner can manage members…" |
| 5 | Owner suspends the member; the member reloads a page | the member is out at once (page not found / sign-in) |
| 6 | Owner restores the member | the member's pages work again |
| 7 | Owner creates a second invitation and revokes it; open its link | "Access denied" |

### 4.6 Isolation check (needs a second household)

1. Provision a second household with a different owner (4.1) and sign that owner in (4.2).
2. As the second owner, open `https://<first slug>.darerp.net/ar`. Expected: page not found.
3. As the first owner, open the second household's subdomain. Expected: page not found.
4. Each owner's Members and Invitations pages list only their own household.

### 4.7 Sign-off

The go-live is verified when 3.4, 2.3 (A and B) and 4.1–4.6 all match. If any step fails: stop, keep the evidence (request id from the response, time, screenshot), and do not invite real users.

Clean-up after the test: remove the test member (Members → Remove). A household cannot be deleted through the application; choose the first household's real slug and name in 4.1 so that it does not need to be.
