# Hosting on a Mac mini behind a router (Cloudflare Tunnel)

The same three containers as `deploy/README.md`, with one change: instead of Caddy and open ports, a **Cloudflare Tunnel** carries traffic from Cloudflare to the Mac over an outbound connection. No router changes, no fixed IP address; Cloudflare issues and renews the certificates.

**Status: written, not yet run on a Mac.** The images were built and run on Linux (Intel/AMD). On an Apple-chip Mac they build for ARM; nothing in the Dockerfile is processor-specific, but that build and the tunnel have not been exercised. Treat the first run as a test.

## 1. The Mac (once)

1. **Docker**: install Docker Desktop for Mac (Apple silicon) or OrbStack. In its settings: start at login; give it at least 6 GB memory and 4 CPUs.
2. **Command-line tools**: `xcode-select --install` (provides `git` and `python3`).
3. **Stay awake** (System Settings → Energy): "Prevent automatic sleeping when the display is off" on; "Start up automatically after power failure" on; "Wake for network access" on.
4. **Start after a reboot**: Docker starts only after a user logs in. Either turn on automatic login for the account that runs Docker (System Settings → Users & Groups; not available while FileVault is on), or accept that someone must log in after every restart. Containers then come back by themselves (`restart: unless-stopped`).
5. **macOS updates**: set to manual, and restart at a time you choose.

```bash
mkdir -p ~/dar && cd ~/dar
git clone https://github.com/majidassaleh-del/Dar-app.git . # or: git clone /path/to/dar-app.bundle .
cp deploy/env.production.example .env.production && chmod 600 .env.production
mkdir -p secrets && chmod 700 secrets          # gcp-kms.json goes here (chmod 600)
alias dc='docker compose --env-file .env.production'
```

In `.env.production` set `COMPOSE_PROFILES=tunnel`, leave `ACME_EMAIL` and `TENANT_HOSTS` empty, and fill in the rest as the file explains.

## 2. Cloudflare (once)

`darerp.net` must use Cloudflare's nameservers (add the site in Cloudflare, then change the nameservers at the registrar).

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.** Name it, then copy the **token** shown in the install command into `CLOUDFLARE_TUNNEL_TOKEN`. Do not install cloudflared on the Mac: the stack runs it in a container.
2. **Public hostnames** of that tunnel, in this order (the first match wins):

   | Hostname | Service |
   |---|---|
   | `api.darerp.net` | `http://api:4000` |
   | `darerp.net` | `http://web:3000` |
   | `app.darerp.net` | `http://web:3000` |
   | `*.darerp.net` | `http://web:3000` |

   Cloudflare creates the DNS records for the first three. For the wildcard, add the DNS record yourself: type `CNAME`, name `*`, target `<tunnel id>.cfargotunnel.com`, proxied. With it, every household subdomain works as soon as the household exists; nothing to add per household.
3. **SSL/TLS**: mode "Full"; Edge Certificates → "Always Use HTTPS" on. The free Universal certificate covers `darerp.net` and `*.darerp.net`.
4. Leave Rocket Loader and any "cache everything" rule **off** for this site: pages are personal and must not be cached or rewritten.

## 3. Build, database, start

```bash
dc build api web db
dc run --rm db                              # schema, security rules, service roles
dc run --rm db deploy/operator-key.sh       # prints the operator key once
dc up -d                                    # api, web, cloudflared
dc ps                                       # api and web "healthy"; cloudflared "running"
dc logs cloudflared | tail                  # "Registered tunnel connection" ×4
deploy/smoke.sh darerp.net                  # every line "ok"
```

Then the first household (`deploy/create-household.sh …`, see `deploy/README.md` §5) and the live smoke test (`docs/04-go-live.md` §4).

## 4. Scheduled jobs

`crontab -e` (macOS may ask to allow `cron` under Privacy & Security → Full Disk Access):

```cron
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
15 3 * * *  cd $HOME/dar && docker compose --env-file .env.production run --rm -T worker reminders:sync
30 3 * * *  cd $HOME/dar && docker compose --env-file .env.production run --rm -T worker recurring:run
*/5 * * * * cd $HOME/dar && docker compose --env-file .env.production run --rm -T worker notifications:dispatch
0 4 1 * *   cd $HOME/dar && docker compose --env-file .env.production run --rm -T worker esb:accrue
```

## 5. What lives where, and backups

| Data | Where | Backup |
|---|---|---|
| Database, sign-in identities | Supabase (not on the Mac) | Supabase backups |
| Uploaded files (transfer screenshots, documents) | Docker volume `dar_storage` **on the Mac only** | `docker run --rm -v dar_storage:/data:ro -v ~/dar-backups:/out busybox tar czf /out/storage-$(date +%F).tgz -C /data .` to a disk that is not the Mac. Time Machine does not back up Docker volumes reliably |
| `.env.production`, `secrets/` | The Mac | A sealed copy elsewhere. Without `AUTH_TOTP_KEY` every authenticator enrolment is lost; without the KMS key encrypted fields are unreadable |

Never run `docker compose down -v`: `-v` deletes the volumes.

## 6. Limits of one machine at home or in an office

- A power cut, an internet outage or a macOS restart takes the site down until it is back. There is no second machine.
- Home internet upload speed limits how fast pages and files load for people outside.
- Running Supabase itself on the same Mac is possible but is a separate, heavier installation that this guide does not cover. With managed Supabase, the Mac holds no database.
