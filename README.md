# Household ERP: platform foundation

Multi-tenant household ERP (web + mobile), Arabic-first with 6 languages.

| Path | What it is |
|---|---|
| `docs/01-architecture.md` | Architecture: stack, modules, tenancy, RBAC, encryption, i18n/RTL, key flows, deployment |
| `docs/02-api.md` | Core REST API (`/v1`) for all modules, plus realtime and webhooks |
| `docs/03-deployment.md` | SaaS domain layout (`darhub.net`), environment variables, CORS, cookies and tenant subdomains |
| `prisma/schema.prisma` | Data model (61 tables) |
| `prisma/migrations/0001_init` | Initial DDL |
| `prisma/migrations/0002_…` | Governance, petty cash, work orders, travel, encrypted columns, EFA role, CHECK constraints |
| `prisma/seed.sql` | Permission catalogue (43) and default role matrix (8 roles, names in 6 languages) |
| `prisma/rls.sql` | Row-level security: tenant isolation, role scopes, write coverage, escalation guards, workflow triggers |
| `tests/rls_test.sql` · `tests/apply.sh` | Database security suite (rebuilds a scratch DB, then runs the suite) |
| `packages/i18n` | Locales, direction, Accept-Language negotiation, `resolveI18n`, ICU catalogues ×6 |
| `packages/zatca` | ZATCA e-invoice QR (TLV) decoder/encoder and validation |
| `packages/receipt-parser` | OCR text parser (Arabic/English), ZATCA merge, QR detection, `processReceiptImage` |
| `packages/crypto` | KMS envelope encryption (Cloud KMS / local), blind index, Saudi ID and IBAN validators |
| `apps/web` | Next.js 15 + next-intl 4: `/ar /en /hi /tl /am /bn`, RTL/LTR |
| `apps/api` | NestJS 11 API: RLS request context, JWT and household guards, problem+json errors, field encryption (`CryptoModule`), **Staff HR** (`src/staff/`), worker jobs (`src/worker/`), e2e tests |
| `scripts/dev-db.sh` · `scripts/dev-fixtures.sql` | Local DB with the `herp_api` login role and demo households |
| `apps/mobile` | Expo i18n root (`use-intl`); source only, not yet in the workspace |

```bash
pnpm install
pnpm -r --filter "./packages/*" test        # unit tests
pnpm --filter @herp/web build               # web build (type-checks too)
cp .env.example .env && npx prisma validate   # needs DATABASE_URL / DIRECT_URL set
tests/apply.sh                              # DB: migrations + seed + RLS + security suite (needs local Postgres)
pnpm db:generate                            # Prisma client
pnpm --filter @herp/api test                # API e2e against a fresh Postgres DB
scripts/dev-db.sh herp_dev --fixtures       # then: cd apps/api && cp .env.example .env && pnpm build && pnpm start
```

**Live executive dashboard (demo).** With the API running on `:4000` against `herp_dev`:

```bash
psql herp_dev -f scripts/demo-households.sql            # EFA Private Office + AFA Household
AUTH_JWT_SECRET=… node scripts/demo-seed.mjs            # seeds via the API, prints HERP_DEV_TOKEN=…
# node scripts/demo-seed.mjs --extras-only              # adds bank, petty cash, work orders, requests, salaries to an existing seed
HERP_API_URL=http://localhost:4000 HERP_DEV_TOKEN=… pnpm --filter @herp/web dev
```

`HERP_DEV_TOKEN` is ignored when `NODE_ENV=production`, where the token comes from the httpOnly `herp_session` cookie. Without either, the dashboard shows labelled sample data.

Production on a SaaS domain (`darhub.net`: app, API and tenant subdomains, CORS and cookies) is described in [`docs/03-deployment.md`](docs/03-deployment.md).

`rls.sql` must be applied by a role with BYPASSRLS (it checks and aborts otherwise).

## Building API modules (`apps/api`)

Every module follows the reference `src/members/members.controller.ts`:

1. **All database work goes through `db.withRls(ctx, tx => …)`.** It opens one transaction, runs `SET LOCAL ROLE app_user`, and sets `app.user_id` / `app.household_id`. Don't write tenant `WHERE` clauses or repeat permission checks in TypeScript: RLS and the triggers decide. The login role `herp_api` has no table privileges, so a query outside `withRls` fails (an e2e test enforces this).
2. **Let the database refuse.** `ProblemFilter` maps Postgres errors to RFC 9457 responses: `42501` → 403, `23514` (trigger rule) → 422, `23505` → 409. Under RLS, a row that is invisible to an update is "0 rows", so return 404 for it.
3. **Context.** Guards run in order (`JwtGuard`, then `HouseholdGuard`) and attach `@Ctx()`: `userId`, `householdId`, `membershipId`, the negotiated `locale` and `requestId`. Use `@Public()` for health and webhooks, and `@NoHousehold()` for `/me` and `POST /households`.
4. **Validation.** Use a Zod schema per body with `new ZodBody(schema)`, and `.strict()` to reject unknown fields.
5. **Localisation.** Resolve `*I18n` columns with `resolveI18n(value, { locale: ctx.locale })`.
6. **Encrypted fields.** Pass plaintext through `seal(crypto.cipher, 'table.field', householdId, value)` before writing and `unseal(…)` to read, inside `withRls`. Keys are loaded through the request's own RLS transaction. Never return `*Ciphertext` or `*BlindIndex` columns; map rows to DTOs.
7. **Audit.** Use `audit(tx, ctx, {...})` (no RETURNING), so a caller can log their own action without reading the audit log.
8. **Workers** (OCR, receipt confirmation, key provisioning, reminders) log in as `herp_worker`, act as `app_service` (BYPASSRLS) through `ServiceDb.run`, and must always filter by `householdId` explicitly. `node dist/worker.js keys:provision | reminders:sync | recurring:run | notifications:dispatch | esb:accrue [YYYY-MM]`.

## Quality gate (local and CI)

`bash scripts/verify.sh` runs every check before a commit: Prisma validate/generate, schema drift, the RLS and isolation suite, package tests, API type-check, API e2e and the web build. It needs a PostgreSQL 16 superuser:
- **Locally:** the `postgres` OS user (peer auth).
- **CI or another host:** set `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD` (see `scripts/pg.sh`).

`.github/workflows/ci.yml` runs the same script on every push and pull request to `main`:
- **Runtime:** Node 22, pnpm from `packageManager`, `pnpm install --frozen-lockfile`.
- **Database:** a `postgres:16` service container, with `pgcrypto`, `citext` and `pg_trgm` enabled.
- **On failure:** the per-check logs are uploaded as an artifact.
