# 05 · Handover

Written when the project moved to a new working account. It replaces the conversation history: everything a new person (or assistant) needs to continue.

## 1. State

- Branch `main` is the only branch. All work is committed and pushed; nothing is deployed anywhere.
- `scripts/verify.sh` passes: 224 database security assertions, 287 API tests, shared-package tests, web build.
- The Docker images build and run in production mode on Linux (Intel/AMD). **Not yet run:** on the Mac mini (ARM), through Cloudflare Tunnel, against a real Supabase project, Google Cloud KMS, or a real SMS / e-mail gateway.

## 2. What exists

| Area | Summary |
|---|---|
| Tenancy | One household = one tenant. Postgres RLS on every table; the API adds a membership check; the web resolves the household from the subdomain or a cookie |
| Accounts | Invitation-only. No sign-up. Sign-in = code to phone / e-mail (Supabase) → first-time phone, e-mail and authenticator setup → authenticator code → session until 04:00 Riyadh |
| Households | Created only by the platform operator: `POST /v1/operator/create-household` with an operator key checked by the database |
| Owner | An active Household Head. Alone may invite, change roles, suspend / remove, define custom roles, edit role permissions and per-member overrides |
| Landing page | Owner entry, member entry, invitation field. The owner entry refuses anyone who heads no household |
| Modules with screens | Home board, staff, payroll, requests, finance, petty cash, vehicles, work orders, members, roles, permissions, invitations, payslip |
| Modules in the API only | Ledger, banking and statement import, budgets, receipts OCR, HR extensions, governance, travel, offline sync, notifications |
| Mobile | `apps/mobile` is source only; not built |

## 3. Decisions the owner made (do not reopen without asking)

- Salaries are paid on the **28th of each Gregorian month**. The pay day is a household setting (default 28).
- No attendance clock-in / clock-out in phase 1: the workers live in.
- A **bank-transfer screenshot is sufficient proof** of a salary payment (transfers to domestic workers go through Musaned).
- Payslips are in the worker's language and show deductions.
- Visual design: the "Diwan" theme with the operations-board home page (called design #7). Earlier layouts were rejected as generic.
- Vendors get no login. The office records vendor details and visits, with reminders for the next visit.
- Official letters are generated from data in the system and exported as PDF.
- Domain: `darerp.net`. Product name in messages: `Dar`.
- Hosting: Docker Compose; a Mac mini (Apple M4) reached through Cloudflare Tunnel; Supabase for the database and sign-in; uploads on a Docker volume.
- Role and permission management is owner-only, the EFA office admin included.
- Invitations may go to a phone number, an e-mail address or both.

## 4. Known limits and untested paths

- A web session cannot be revoked before it expires at 04:00 Riyadh (suspension takes effect at once regardless, because membership is checked on every request).
- An invitee without any phone cannot finish first-time setup: it requires both a phone and an e-mail.
- A new invitation link stays visible to the owner for two minutes.
- Households cannot be deleted through the application.
- Permission names are translated into Arabic and English only; other languages show English.
- The owner can invite someone as Household Head or EFA Office Admin (those roles appear in the list).
- File storage is local disk (a Docker volume). There is no object-storage adapter.
- The API image is about 2.3 GB.
- `deploy/db-apply.sh` needs a database role that is superuser or has `BYPASSRLS` and `CREATEROLE`; on managed Supabase this must be tried on a scratch project first.
- Never exercised live: Supabase (sign-up disabled, admin API, asymmetric keys), the OTP gateway, Cloud KMS, Caddy certificates, Cloudflare Tunnel, `deploy/create-household.sh`, `deploy/smoke.sh`.

## 5. Next steps, in the owner's order

1. First run on the Mac mini: `deploy/README-mac-mini.md`, then `docs/04-go-live.md` §4 with two real phones. The first household is "Dar Abo Abdulmalik".
2. Phase 1, still open: **add / edit forms** on the web for staff (with contract and documents), vehicles, petty cash and work orders. Today those screens are read-only apart from approvals, payroll and member management.
3. Later, agreed in principle: official-letters PDF generator; vendors directory with visit log and reminders; worker self-service; a house manual (independent of the other steps, may stay off in phase 1); a setting screen for the pay day.

## 6. Working locally

```bash
pnpm install
scripts/dev-db.sh herp_dev --fixtures         # local database with two demo households
bash scripts/verify.sh                        # the gate for every commit
```

`README.md` has the commands for the demo data, the local sign-in stand-in (`scripts/dev-idp.mjs`) and the dev servers.

Things that have bitten before:
- The login roles `herp_api` / `herp_worker` are shared by every local database. `deploy/db-apply.sh` changes their passwords; after trying it locally, reset them (`ALTER ROLE herp_api PASSWORD 'herp_api_dev'`, `ALTER ROLE herp_worker PASSWORD 'herp_worker_dev'`) or the API tests fail with "authentication failed".
- `scripts/verify.sh` builds the web into `.next`; a dev server using the same folder must be restarted afterwards (or run it with `NEXT_DIST_DIR=.next-dev`).
- The API tests run in parallel against one database: a new test must create its own users and not change the fixture members.
- A non-member asking for a household gets `404`, not `403`, by design.

## 7. Getting the code

- GitHub: `majidassaleh-del/Dar-app`, branch `main`.
- Or from a bundle file (full history, no GitHub needed): `git clone dar-app.bundle Dar-app`, then `git remote set-url origin <new repository URL>` when there is one.
