# Deployment on one server (Docker Compose)

Three containers: **api** (NestJS), **web** (Next.js) and **caddy** (reverse proxy, Let's Encrypt). The database and sign-in are Supabase. Uploaded files live in the Docker volume `dar_storage`.

| File | Purpose |
|---|---|
| `deploy/Dockerfile` | Images `api`, `web`, and `db` (database tooling) |
| `docker-compose.yml` | The stack; each service gets only its own variables |
| `deploy/Caddyfile` | TLS and routing for `DOMAIN`, `app.`, `api.` and household subdomains |
| `deploy/env.production.example` | Template for `.env.production` (stays on the server) |
| `deploy/db-apply.sh` | Schema + security rules; first setup and every upgrade |
| `deploy/operator-key.sh` | Creates and registers the operator key |
| `deploy/create-household.sh` | Provisions a household and its owner |
| `deploy/smoke.sh` | Read-only checks after start |

The full checklist with expected results is `docs/04-go-live.md`. This page is the command sequence.

**Hosting on a Mac mini behind a router (Cloudflare Tunnel):** follow `deploy/README-mac-mini.md` instead of sections 0 and 4 below; everything else is the same.

## 0. Server and DNS (once)

- Ubuntu with Docker Engine and the Compose plugin; ports 80 and 443 open; nothing else listening on them (Caddy replaces Nginx here).
- DNS `A`/`AAAA` records to the server: `darerp.net`, `www`, `app`, `api`, and one per household subdomain (e.g. `abdulmalik`). Caddy requests a certificate per name, so a name must resolve before it is listed in `TENANT_HOSTS`.
- Clone the repository, then:

```bash
cp deploy/env.production.example .env.production && chmod 600 .env.production   # fill it in
mkdir -p secrets && chmod 700 secrets                                            # put gcp-kms.json here, chmod 600
alias dc='docker compose --env-file .env.production'
```

## 1. Build

```bash
dc build api web db
```

## 2. Database (first setup; also after every upgrade)

```bash
dc run --rm db                       # migrations, permission catalogue, security rules, service roles
```

Expected last line: `ok: 16 migrations, 81 tables under row-level security, 359 policies, operator keys on file: 0`.
The owner connection (`DB_OWNER_URL`) is used only by this command. On Supabase it must be the direct connection (port 5432) of a role that is superuser or has `BYPASSRLS` and `CREATEROLE` (self-hosted: `supabase_admin`). If the role lacks that, the script stops with a message and changes nothing.

## 3. Operator key (once)

```bash
dc run --rm db deploy/operator-key.sh      # prints the key ONCE: store it in a password manager
```

## 4. Start

```bash
dc up -d                              # starts api, web and the profile named in COMPOSE_PROFILES
dc ps                                 # api and web: "healthy"
dc logs -f caddy                      # certificates being issued
deploy/smoke.sh darerp.net            # every line "ok"
```

## 5. First household

```bash
deploy/create-household.sh abdulmalik "دار أبو عبدالملك" "Dar Abo Abdulmalik" +9665XXXXXXXX owner@example.com "أبو عبدالملك"
# asks for the operator key (not echoed), creates the household and its encryption key
```

Then add `abdulmalik.darerp.net` to `TENANT_HOSTS` in `.env.production` and run `dc up -d caddy`.
The owner signs in at `https://darerp.net` (owner entry). Continue with `docs/04-go-live.md` §4.2.

## Upgrades

```bash
git pull
dc build api web db
dc run --rm db                        # safe to repeat; applies only what is new
dc up -d
deploy/smoke.sh darerp.net
```

## Scheduled jobs (host crontab)

```cron
# reminders (documents, compliance, vehicles), recurring entries, notifications, end-of-service accrual
15 3 * * *  cd /srv/dar && docker compose --env-file .env.production run --rm -T worker reminders:sync
30 3 * * *  cd /srv/dar && docker compose --env-file .env.production run --rm -T worker recurring:run
*/5 * * * * cd /srv/dar && docker compose --env-file .env.production run --rm -T worker notifications:dispatch
0 4 1 * *   cd /srv/dar && docker compose --env-file .env.production run --rm -T worker esb:accrue
```

## Backups

- **Database**: Supabase backups (managed) or `pg_dump` (self-hosted).
- **Files**: the `dar_storage` volume, e.g.
  `docker run --rm -v dar_storage:/data:ro -v /srv/backups:/out busybox tar czf /out/storage-$(date +%F).tgz -C /data .`
- **Certificates**: the `dar_caddy_data` volume (can be re-issued, but keep it across redeploys).
- **`.env.production` and `secrets/`**: a sealed copy off the server. Without `AUTH_TOTP_KEY` every authenticator enrolment is lost; without the KMS key the encrypted fields are unreadable.

Never run `docker compose down -v`: `-v` deletes the volumes.

## Notes

- The web container never receives the Supabase service-role key or database credentials (`docker compose config` shows what each service gets).
- A wildcard certificate (`*.darerp.net`) instead of per-household names needs Caddy built with your DNS provider's plugin; not included.
- Building behind a TLS-inspecting proxy: `docker build --secret id=extra_ca,src=/path/ca.pem ...` plus the proxy build arguments.
