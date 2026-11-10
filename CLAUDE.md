# Dar — household ERP

Multi-tenant, Arabic-first household ERP: NestJS API (`apps/api`), Next.js web (`apps/web`), Postgres with row-level security (`prisma/`), six languages (`packages/i18n`).

**Read `docs/05-handover.md` first**: current state, the owner's decisions, what is untested, what is next.

## Rules for every change

- Run `bash scripts/verify.sh` before committing; it must print `ok` on every line. It needs a local Postgres (`service postgresql start` on Linux).
- Commit to `main`, keep unrelated changes in separate commits, push with `git push -u origin main`, then confirm `origin/main` equals local `HEAD`.
- Never deploy or run anything against a live server without the owner's explicit approval in that conversation.
- Never commit secrets. `.env*` (except `.env.example`) and `secrets/` are ignored on purpose.
- Tenant isolation is enforced in the database (`prisma/rls.sql`, tested by `tests/rls_test.sql`). A new table, policy or `SECURITY DEFINER` function must pass that suite; a new definer function reachable by requests must be added to its reviewed list.
- Schema changes: edit `prisma/schema.prisma`, add a migration folder under `prisma/migrations/` (`scripts/drift.sh` prints the SQL that is missing), and keep `deploy/db-apply.sh` able to re-apply `prisma/rls.sql`.
- User-facing text goes in all six `packages/i18n/messages/*.json` files with the same keys.
- `next dev` rewrites `apps/web/tsconfig.json`; restore it (`git checkout apps/web/tsconfig.json`) before committing.

## Where things are

| Need | Look at |
|---|---|
| API reference and business rules | `docs/02-api.md` |
| Settings, CORS, cookies, subdomains | `docs/03-deployment.md` |
| Go-live checklist and live smoke test | `docs/04-go-live.md` |
| Docker deployment (server / Mac mini) | `deploy/README.md`, `deploy/README-mac-mini.md` |
| Local development commands | `README.md` |
