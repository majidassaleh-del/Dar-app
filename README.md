# Household ERP: platform foundation

Multi-tenant household ERP (web + mobile), Arabic-first with 6 languages.

| Path | What it is |
|---|---|
| `docs/01-architecture.md` | Architecture: stack, modules, tenancy, RBAC, encryption, i18n/RTL, key flows, deployment |
| `docs/02-api.md` | Core REST API (`/v1`) for all modules, plus realtime and webhooks |
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
| `apps/mobile` | Expo i18n root (`use-intl`); source only, not yet in the workspace |

```bash
pnpm install
pnpm -r --filter "./packages/*" test        # unit tests
pnpm --filter @herp/web build               # web build (type-checks too)
cp .env.example .env && npx prisma validate   # needs DATABASE_URL / DIRECT_URL set
tests/apply.sh                              # DB: migrations + seed + RLS + security suite (needs local Postgres)
```

`rls.sql` must be applied by a role with BYPASSRLS (it checks and aborts otherwise).
