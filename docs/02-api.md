# Household ERP: Core API (REST `/v1`)

The API is REST + JSON, specified as OpenAPI 3.1, with request and response types generated from the shared Zod schemas in `packages/contracts`. GraphQL was considered and rejected for v1. Per-row RLS and permission scopes are simpler to reason about with fixed resource endpoints. Mobile offline sync is served by a dedicated `/sync` endpoint instead.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<domain>/v1` |
| Auth | `Authorization: Bearer <JWT>` (from the auth provider). Staff usually log in with phone OTP. |
| Tenant | `X-Household-Id: <uuid>` is required on every tenant endpoint. The server validates the membership, so a non-member gets `404`, never `403`, which avoids leaking that the household exists. |
| Language | `Accept-Language: ar` (or `en, hi, tl, am, bn`). `*I18n` fields are returned **resolved** as `name: "…"`, plus `nameI18n` if `?i18n=full`. Error messages are localized. |
| Writes | `Idempotency-Key: <uuid>` is required on all POSTs that create money movements, requests or uploads. It is replay-safe for 24 h. |
| Concurrency | `ETag` / `If-Match` on PATCH for ledger, payroll and approval objects. A conflict returns `412`. |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>` returns `{ data: [...], nextCursor }`. |
| Filtering | `?filter[status]=PENDING&filter[occurredAt][gte]=2026-10-01&sort=-occurredAt&q=lulu` |
| Money | `{ "amount": "125.50", "currency": "SAR" }`. Amounts are sent as decimal **strings**, never floats. |
| Dates | ISO-8601 UTC. `?calendar=hijri` adds `*Hijri` display fields. |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, detail, code: "REQUEST_ALREADY_DECIDED", errors: [{ path, code, message }] }` |
| Permission tag | Each endpoint below lists the required permission. The scope (ALL/OWN/ASSIGNED/WARDS) is applied automatically by RLS. |
| Rate limits | 600 req/min per membership; 30/min on OTP & auth; `429` + `Retry-After`. |

---

## 2. Identity, households & RBAC

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/otp/request` | public | `{ phone }` → sends SMS/WhatsApp OTP |
| POST | `/auth/otp/verify` | public | Returns access and refresh tokens |
| POST | `/auth/refresh` | public | |
| POST | `/auth/logout` | self | Revokes the refresh token and device |
| GET | `/me` | self | Profile and the list of memberships `[{householdId, role, displayName}]` |
| PATCH | `/me` | self | `preferredLocale`, `timezone`, name, avatar |
| POST | `/me/devices` | self | Registers a push token |
| DELETE | `/me/devices/{id}` | self | |
| GET | `/me/permissions` | member | Effective permissions and scopes in the active household (drives UI gating) |
| POST | `/households` | self | Creates a household. Calls `app.provision_household`, and the caller becomes HOUSEHOLD_HEAD |
| GET | `/households/current` | member | |
| PATCH | `/households/current` | `admin.household.manage` | Locales, currency, fiscal year, approval thresholds |
| DELETE | `/households/current` | `admin.household.manage` | Soft delete, then crypto-shred after 30 days |
| GET | `/households/current/export` | `admin.household.manage` | Async full data export (PDPL) |
| GET | `/members` | member | Household roster |
| POST | `/members/invitations` | `admin.members.manage` | `{ phone \| email, role, displayName, relationship, guardianId?, expiresAt? }` |
| POST | `/invitations/{token}/accept` | self | |
| GET | `/members/{id}` | member | |
| PATCH | `/members/{id}` | `admin.members.manage` | Role, status (suspend), guardian, expiry |
| DELETE | `/members/{id}` | `admin.members.manage` | Revokes access |
| PUT | `/members/{id}/permissions` | `admin.members.manage` | Overrides `[{ permissionId, granted, scope }]` |
| GET | `/roles` | member | Roles with their permission matrix |
| POST | `/roles` | `admin.members.manage` | Custom role cloned from a system role |
| PATCH · DELETE | `/roles/{id}` | **Head / EFA only** | Protected table. Seeded system roles cannot be deleted |
| GET | `/permissions` | member | Global catalogue (localized descriptions) |
| GET | `/audit-logs` | `admin.audit.read` | Filter by entity, actor or action |

Role changes: granting or changing an admin role (`HOUSEHOLD_HEAD`, `EFA_OFFICE_ADMIN`) and editing role matrices or overrides are refused with `403` for non-admins. Removing or demoting the last active Head returns `409 LAST_HEAD`.

## 3. Staff HR

> **Status: implemented**: everything in this section. Code is in `apps/api/src/staff/`, with e2e tests in `apps/api/test/staff.e2e.test.ts` and `hr.e2e.test.ts`. Notes on the implementation:
> * **Attendance.** Workers check in and out for *today* (household time zone), once each, with server-stamped times. Only `staff.payroll.manage` can correct a day (`PUT /attendance/{staffId}/{date}`).
> * **Leave.** Leave is requested with `POST /requests {type: "LEAVE", leaveType, startDate, endDate}`. Final approval creates the `LeaveRecord` in the database, and the request becomes `FULFILLED`. Filing for another worker needs `staff.payroll.manage`. `GET /staff/{id}/leave-balance?year=` returns the pro-rated annual entitlement minus approved ANNUAL days.
> * **Payroll.** `POST /payroll-runs` generates the lines:
>   * basic salary and each allowance, pro-rated by days employed;
>   * unpaid leave deducted at basic ÷ 30 per day;
>   * salary-advance instalments, capped at the pay.
>
>   Lines are editable only while DRAFT. `/pay` validates every worker's channel and reference **before** writing, then logs one `SalaryPayment` per worker and reduces the advances. PAID is final.
> * **Payslips.** A worker sees only their own APPROVED or PAID payslips, never run totals. Line text follows the viewer's language.
> * **Chores.** An assignee may only change `status` and `proofPhotoUrl`. Only the creator or a manager can cancel or delete.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/staff` | `staff.profile.read` | Filters: `staffType`, `status`. Staff see only themselves |
| POST | `/staff` | `staff.profile.manage` | |
| GET | `/staff/{id}` | `staff.profile.read` | |
| PATCH | `/staff/{id}` | `staff.profile.manage` | |
| POST | `/staff/{id}/status` | `staff.profile.manage` | `{ status, effectiveDate?, reason? }`. Transitions are enforced (for example, FINAL_EXIT is final and ABSCONDED can return to ACTIVE); `422` otherwise. Audited |
| | *(on POST/PATCH `/staff`)* | | `borderNumber` and `payoutIban` (mod-97 checked) are accepted in plaintext and stored encrypted. Responses show only `hasBorderNumber` and `payout.ibanLast4`. `defaultPayoutChannel`: `MUSANED \| BANK_TRANSFER \| CASH \| DIGITAL_WALLET`; BANK_TRANSFER needs an IBAN |
| POST | `/staff/{id}/app-access` | `admin.members.manage` | Creates or links a Membership (STAFF/DRIVER role) and sends an OTP invite in the staff member's language |
| GET | `/staff/{id}/documents` | `staff.documents.read` | Passport, iqama, visa, licence (number masked) |
| POST | `/staff/{id}/documents` | `staff.profile.manage` | |
| PATCH | `/staff/{id}/documents/{docId}` | **Head / EFA only** | Renewals, custody flag (protected table) |
| GET | `/staff/{id}/documents/{docId}/reveal` | `staff.documents.read` | Decrypts via the tenant DEK (KMS). Audited `VIEW_SENSITIVE` |
| GET | `/staff/documents/lookup?type=IQAMA&number=` | `staff.documents.read` | Exact match through the blind index; no decryption |
| GET | `/staff/documents/expiring?withinDays=60` | `staff.documents.read` | Expired documents, plus those inside the window (default = largest tier). Each has `daysLeft` and `alertTier` (`EXPIRED`, `15`, `30`, `60`), and `summary` counts per tier. Days are counted in the household's time zone |
| | *(on POST `/staff/{id}/documents`)* | | `number` is validated per type (Iqama: 10 digits starting with 2 plus a Luhn check digit; national ID: starting with 1; passport: 6–12 alphanumeric). It is encrypted, with last-4 and a blind index stored beside it. A duplicate number in the household returns `409`. `alertDays` defaults to `households.settings.documentAlertDays`, else `[60, 30, 15]` |
| GET | `/staff/{id}/contracts` | `staff.payroll.read` | |
| POST | `/staff/{id}/contracts` | `staff.profile.manage` | A new active contract supersedes the previous one |
| GET | `/staff/{id}/end-of-service?asOf=` | `staff.payroll.read` | Calculated entitlement |
| GET | `/staff/{id}/leave-balance` | `staff.payroll.read` | |
| GET | `/leaves` | `staff.payroll.read` | Leave requests themselves go through `/requests` (type `LEAVE`) |
| GET | `/attendance?date=&staffId=` | `staff.payroll.read` | |
| POST | `/attendance/check-in` | `staff.attendance.manage` | Self check-in from mobile `{ geo? }` |
| POST | `/attendance/check-out` | `staff.attendance.manage` | |
| PUT | `/attendance/{staffId}/{date}` | `staff.payroll.manage` | Manual correction |
| GET | `/payroll-runs` | `staff.payroll.read` (ALL) | |
| POST | `/payroll-runs` | `staff.payroll.manage` | `{ year, month }` generates a DRAFT with lines |
| GET | `/payroll-runs/{id}` | `staff.payroll.read` (ALL) | |
| PATCH | `/payroll-runs/{id}/lines/{lineId}` | `staff.payroll.manage` | Adjust bonus or deduction while DRAFT |
| POST | `/payroll-runs/{id}/approve` | `staff.payroll.manage` | |
| POST | `/payroll-runs/{id}/pay` | `staff.payroll.manage` | `{ fromAccountId }` posts ledger transactions and sends payslips |
| GET | `/payslips` | `staff.payroll.read` | Staff see their own; `?format=pdf` renders in the staff member's locale |
| GET | `/salary-advances` | `staff.payroll.read` | |
| POST | `/staff/{id}/salary-payments` | `staff.payroll.manage` | Domestic-worker pay log, **outside WPS/Mudad** (no SIF file, no Saudi-bank IBAN rule, cash allowed). `{ periodYear, periodMonth, amount?, channel?, externalRef?, paidAt?, note?, proofFileId? }`. `amount` defaults to the active contract (basic + allowances) and `channel` to the worker's default. MUSANED and BANK_TRANSFER require `externalRef`. The response includes the period summary and an over-payment warning |
| GET | `/salary-payments?year=&month=&staffId=&status=` · `/staff/{id}/salary-payments` | `staff.payroll.read` | Workers see only their own |
| POST | `/salary-payments/{id}/acknowledge` | **the worker only** | `{ method? }`. The Head cannot acknowledge on the worker's behalf (`403`); this is the dispute evidence |
| POST | `/salary-payments/{id}/dispute` | **the worker only** | `{ reason }` |
| POST | `/salary-payments/{id}/reverse` | `staff.payroll.manage` | `{ reason }`. REVERSED is final; a correction is a new row. Rows can't be edited (no route; DB column grants) |
| GET | `/staff/{id}/salary-statement?year=` | `staff.payroll.read` | Per month: due under the contract, paid, confirmed by the worker, outstanding, and status (`UNPAID`, `PARTIAL`, `PAID_UNCONFIRMED`, `PAID_CONFIRMED`, `DISPUTED`) |
| *(worker)* | `node dist/worker.js reminders:documents` | `app_service` | Daily idempotent sweep. One reminder per tier at 09:00 local on expiry − tier. The current tier fires immediately and overtaken tiers are skipped. Renewal reschedules. Expired documents get one EXPIRED reminder. Tier ≤ 15 also goes to WhatsApp |
| GET | `/tasks` | `staff.tasks.manage` / assignee | `?assignee=me&status=TODO` |
| POST | `/tasks` | `staff.tasks.manage` | Auto-translated to the assignee's language |
| PATCH | `/tasks/{id}` | `staff.tasks.manage` / assignee | Assignees may only change `status` and `proofPhoto` |

## 4. Household accounting

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/accounts` | `finance.accounts.read` | Bank, cash box, wallet, credit card, loan. A custodian sees their own petty cash |
| POST | `/accounts` | `finance.accounts.manage` | |
| PATCH | `/accounts/{id}` | `finance.accounts.manage` | |
| GET | `/accounts/{id}/balance-history?from=&to=` | `finance.accounts.read` | |
| POST | `/accounts/{id}/reconcile` | `finance.accounts.manage` | `{ statementBalance, asOf }` |
| POST | `/accounts/{id}/bank-link` | `finance.accounts.manage` | Starts the open-banking consent flow and returns a redirect URL |
| POST | `/accounts/{id}/top-up` | `finance.accounts.manage` | Refills petty cash = TRANSFER |
| GET | `/cards` | `finance.cards.read` | Holders see their own; guardians see wards' cards |
| POST | `/cards` | `finance.cards.manage` | Registers or issues a card (via the issuer partner for virtual cards) |
| PATCH | `/cards/{id}` | `finance.cards.manage` | Limits, allowed categories, nickname |
| POST | `/cards/{id}/freeze` · `/unfreeze` | `finance.cards.manage` or holder | A holder may freeze their own card (lost card) |
| GET | `/categories` | member | Localized tree |
| POST | `/categories` · PATCH · DELETE `/categories/{id}` | `finance.budgets.manage` | |
| GET | `/transactions` | `finance.transactions.read` | Filters: account, card, category, spentBy, vehicle, property, status, date range, `q` |
| POST | `/transactions` | `finance.transactions.create` | Expense, income or transfer. Staff/dependents are limited to their own custody account or card |
| GET | `/transactions/{id}` | `finance.transactions.read` | Includes receipts and the linked request |
| PATCH | `/transactions/{id}` | `finance.accounts.manage` | Only category, tags, description, or `PENDING→POSTED` |
| POST | `/transactions/{id}/reverse` | `finance.accounts.manage` | Creates a reversal row (there is no DELETE) |
| POST | `/transactions/import` | `finance.accounts.manage` | CSV/OFX bank statement |
| POST | `/receipts` | `finance.receipts.upload` | `{ mimeType, sha256, size }` returns `{ receiptId, uploadUrl }` |
| POST | `/receipts/{id}/complete` | uploader | Triggers OCR |
| GET | `/receipts?status=EXTRACTED` | `finance.transactions.read` | Review queue |
| GET | `/receipts/{id}` | uploader / `finance.transactions.read` | Extracted fields and confidence |
| POST | `/receipts/{id}/confirm` | `finance.transactions.create` | Accept or edit the suggestion, which creates or links a Transaction. The link is written by the worker (`app_service`), because receipt UPDATE is Head/EFA-only |
| PATCH · DELETE | `/receipts/{id}` | **Head / EFA only** | Protected table |
| GET | `/budgets` | `finance.transactions.read` | Includes `spent`, `remaining`, `pct` |
| POST | `/budgets` | `finance.budgets.manage` | |
| PATCH · DELETE | `/budgets/{id}` | **Head / EFA only** | Protected table |
| GET | `/recurring` · POST · PATCH · DELETE `/recurring/{id}` | `finance.accounts.manage` | Bills, subscriptions |
| GET | `/allowances` | `finance.transactions.read` | Dependents see their own |
| POST | `/allowances` | `finance.allowance.manage` (WARDS) | Cannot target oneself |
| PATCH · DELETE | `/allowances/{id}` | **Head / EFA only** | Protected table |
| POST | `/allowances/{id}/payout` | `finance.allowance.manage` | Manual or extra payout |
| GET | `/reports/spending?groupBy=category\|member\|vehicle\|property&period=` | `finance.reports.read` | |
| GET | `/reports/cashflow?from=&to=` | `finance.reports.read` | |
| GET | `/reports/staff-cost?year=` | `finance.reports.read` | Salaries, advances, tickets, iqama fees |
| GET | `/reports/export?type=…&format=xlsx\|pdf\|csv` | `finance.reports.read` | Async job, signed download URL |

## 4a. Double-entry ledger (`/v1/ledger`)

> **Status: implemented** in `apps/api/src/ledger/`, with e2e tests in `apps/api/test/ledger.e2e.test.ts` and attack tests in the DB suite. The single-entry `/transactions` API in §4 is not built yet. When it is, it will post through the same hooks.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/ledger/accounts?asOf=` | `finance.ledger.read` | Chart of accounts with debits, credits and balance in the normal direction. The 15 system accounts are seeded at provisioning, plus one account per petty-cash float |
| POST | `/ledger/accounts` | `finance.ledger.manage` | `{ code, name, type, parentId?, isHeader?, categoryId? }`. An EXPENSE account mapped to a category receives that category's petty-cash expenses |
| PATCH | `/ledger/accounts/{id}` | `finance.ledger.manage` | Name, active flag, parent, category. System accounts can only be renamed or deactivated. An account with postings can't change type or become a header |
| GET | `/ledger/accounts/{id}/statement?from=&to=` | `finance.ledger.read` | Opening balance, lines with running balance, closing balance |
| GET | `/ledger/journal?from=&to=&source=&sourceId=&accountId=&staffId=` | `finance.ledger.read` | Entries with lines. `sourceId` finds the entry a petty-cash log, payroll run, salary payment or advance produced |
| GET | `/ledger/journal/{id}` | `finance.ledger.read` | |
| POST | `/ledger/journal` | `finance.ledger.manage` | MANUAL (or `opening: true` → OPENING_BALANCE). `{ entryDate, description, lines: [{ accountId, debit \| credit, staffId?, memo? }] }`. Must balance (`400` with the totals). Header or foreign-household accounts → `422` |
| POST | `/ledger/journal/{id}/reverse` | `finance.ledger.manage` | `{ reason }`. Posts a mirror entry dated today (or the day after the lock) and marks the original REVERSED. Only once |
| GET | `/ledger/trial-balance?asOf=` | `finance.ledger.read` | Debit and credit balances per account, totals, and `balanced` |
| GET | `/ledger/staff/{staffId}` | `finance.ledger.read` | Worker sub-ledger: advances outstanding, owed by the worker (rejected petty cash), salary payable, salary cost to date |
| GET | `/ledger/settings` · POST `/ledger/close-books` | read / **Head or EFA** | `{ through }`: a past date, forward only, audited. Nothing can be dated on or before it |

**Automatic postings** (database triggers; once per source event, unique on `(household, source, sourceId)`):

| Event | Entry |
|---|---|
| Petty-cash top-up / return | Dr float / Cr 1190 Owner funding clearing (return is the reverse) |
| Expense **approved** (or recorded by a manager) | Dr the category's mapped account, else 6200 Household expenses / Cr float |
| Expense **rejected** | Dr 1300 Staff receivables (the custodian's sub-ledger) / Cr float |
| Count variance | Shortage: Dr 6950 / Cr float. Surplus: Dr float / Cr 4900 |
| Payroll run → **PAID** | Per worker: Dr 6100 earnings, Cr 6100 unpaid-leave deductions, Cr 1310 advance recovery, Cr 2100 net |
| Salary payment | Dr 2100 (inside a run) or Dr 6100 (outside a run) / Cr 1190. Reversing the payment reverses its entry |
| Salary advance issued | Dr 1310 (the worker's sub-ledger) / Cr 1190 |

**Database invariants:**
* Every entry balances with at least 2 lines (deferred constraint).
* A line is a debit XOR a credit.
* Lines can only be added in the transaction that created the entry. A posted entry can't be extended later, even with a balanced pair.
* No UPDATE or DELETE on entries or lines for any interactive user.
* Users can't post hook sources.
* Header accounts take no postings.
* All references stay inside the household (same-household triggers).
* The period lock is only writable through `app.close_books()`.

## 5. Requests & approvals (cross-module)

> **Status: implemented** in `apps/api/src/requests/`: create, list (`?mine`, `?awaitingMe`), get, approve, reject, cancel. Routing, step advancement, final approval and fulfilment (LEAVE → leave record, SALARY_ADVANCE → advance with instalments) run as database triggers.
>
> Rules:
> * Requesters can only edit a DRAFT, submit it, or cancel it. The v1.1 hole that let a requester set their own request to APPROVED is closed.
> * Approvers decide once, at the current step only, and a rejection needs a comment.
> * PATCH, delegate, comments and fulfil are not implemented yet.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/requests` | `requests.read` | `?mine=true`, `?awaitingMe=true`, type, status |
| POST | `/requests` | `requests.create` | `{ type, title, payload, amount?, neededBy?, priority }`. The payload is validated per type (see below) |
| GET | `/requests/{id}` | party / `requests.read` | Includes the approval chain, comments and attachments |
| PATCH | `/requests/{id}` | requester | Only while `DRAFT`/`SUBMITTED` |
| POST | `/requests/{id}/cancel` | requester | |
| POST | `/requests/{id}/approve` | approver of the current step | `{ comment? }` |
| POST | `/requests/{id}/reject` | approver of the current step | `{ comment }` (required) |
| POST | `/requests/{id}/delegate` | approver | `{ toMembershipId }` |
| POST | `/requests/{id}/fulfil` | `requests.approve` | e.g. the purchase was made. Links a transaction |
| POST | `/requests/{id}/comments` | party | Auto-translated thread |
| GET | `/approval-policies` · POST · PATCH · DELETE `/{id}` | `requests.approve` (ALL) | Amount bands, step chains, auto-approve threshold |

Request `payload` schemas by `type`:

| type | payload |
|---|---|
| `PURCHASE` | `{ items: [{ name, qty, estPrice }], store?, cardId? }` |
| `REIMBURSEMENT` | `{ receiptIds: [] }` |
| `SALARY_ADVANCE` | `{ installments: 1..12 }` |
| `LEAVE` | `{ leaveType, startDate, endDate, needsExitReentry: bool }` |
| `ALLOWANCE_TOPUP` | `{ reason }` |
| `CARD_LIMIT_CHANGE` | `{ cardId, newDailyLimit?, newMonthlyLimit? }` |
| `VEHICLE_USAGE` | `{ vehicleId?, from, to, purpose, destination }` |
| `MAINTENANCE` | `{ ticketId \| vehicleId, estimate }` |

## 6. Investments & assets

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/portfolios` · POST · PATCH `/portfolios/{id}` | `invest.read` / `invest.manage` | |
| GET | `/portfolios/{id}/holdings` | `invest.read` | Includes market value, unrealised P/L and allocation % |
| GET | `/portfolios/{id}/performance?period=1Y` | `invest.read` | TWR / XIRR |
| GET | `/assets` · POST · PATCH `/assets/{id}` | `invest.read` / `invest.manage` | Equity, sukuk, gold (karat and grams), crypto, real estate (links a property) |
| GET | `/assets/search?q=aramco` | `invest.manage` | Instrument lookup from the market-data adapter |
| GET | `/assets/{id}/valuations` | `invest.read` | Price history |
| POST | `/assets/{id}/valuations` | `invest.manage` | Manual or appraisal value |
| GET | `/investment-transactions` | `invest.read` | |
| POST | `/investment-transactions` | `invest.manage` | Buy, sell, dividend… Recomputes the holding; optionally mirrors cash to `/transactions` |
| POST | `/investment-transactions/import` | `invest.manage` | Broker statement CSV |
| GET | `/net-worth?asOf=` | `invest.read` | Assets + cash − liabilities, by class and currency |
| GET | `/net-worth/history?interval=month` | `invest.read` | |
| GET | `/zakat?hawlEnd=&nisab=gold\|silver` | `invest.read` | Calculation with a per-asset breakdown |

## 7. Vehicle fleet

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/vehicles` | `fleet.read` | Drivers see their assigned vehicles only |
| POST | `/vehicles` · PATCH `/vehicles/{id}` | `fleet.manage` | |
| GET | `/vehicles/{id}` | `fleet.read` | Includes the current driver, upcoming expiries and cost per km |
| POST | `/vehicles/{id}/odometer` | `fleet.trips.log` | `{ km, photo? }` |
| GET | `/vehicles/{id}/assignments` · POST | `fleet.read` / `fleet.manage` | Assign a driver |
| PATCH · DELETE | `/vehicle-assignments/{id}` | **Head / EFA only** | End or correct an assignment (protected table) |
| GET | `/vehicles/{id}/maintenance` · POST | `fleet.read` / `fleet.manage` | Scheduled or completed. Can create a linked transaction |
| PATCH | `/maintenance/{id}` | `fleet.manage` | Complete and set the next due km/date |
| GET | `/maintenance/upcoming?withinDays=30` | `fleet.read` | |
| GET | `/vehicles/{id}/fuel-logs` · POST | `fleet.read` / `fleet.fuel.log` | Driver logs a fill-up (with receipt); computes L/100 km |
| GET | `/vehicles/{id}/trips` · POST `/trips/start` · POST `/trips/{id}/end` | `fleet.read` / `fleet.trips.log` | School runs and errands, with passengers |
| GET | `/violations` · POST · PATCH `/violations/{id}` | `fleet.read` / `fleet.manage` | `status: PAID \| CHARGED_TO_STAFF` (creates a payroll deduction) |
| POST | `/violations/sync` | `fleet.manage` | Pull from the government adapter where available |
| GET | `/reports/fleet?vehicleId=&period=` | `fleet.read` (ALL) | Total cost of ownership |

## 8. Property management

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/properties` · POST · PATCH · DELETE `/properties/{id}` | `property.read` / `property.manage` | |
| GET | `/properties/{id}/units` · POST · PATCH `/units/{id}` | `property.read` / `property.manage` | Floors, annexes, apartments, with sub-meters |
| GET | `/leases` · POST · PATCH `/leases/{id}` | `property.read` / `property.manage` | `direction: LANDLORD \| LESSEE`. Generates the `RentPayment` schedule (Gregorian or Hijri) |
| POST | `/leases/{id}/renew` · `/terminate` | `property.manage` | |
| GET | `/rent-payments?status=due\|overdue` | `property.read` | |
| POST | `/rent-payments/{id}/record` | `property.manage` | `{ amount, paidAt, accountId }` posts a transaction |
| GET | `/utility-bills` · POST · PATCH `/utility-bills/{id}` | `property.read` / `property.manage` | |
| POST | `/utility-bills/{id}/allocate` | `property.manage` | Splits a bill across units by meter reading or fixed share. Returns a per-unit statement |
| GET | `/properties/{id}/statement?month=` | `property.read` | Rent, utilities and maintenance per unit (PDF/XLSX) |
| GET | `/tickets` | `property.read` / reporter / assignee | |
| POST | `/tickets` | `property.tickets.create` | Anyone, including the maid, can report "AC leaking" with a photo |
| PATCH | `/tickets/{id}` | `property.manage` / assignee | Assign, set vendor, cost, resolve |

## 9. HR governance & policy

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/policies` | `governance.read` | Staff see PUBLISHED policies for their `staffType`, resolved to their language. Managers also see drafts |
| POST | `/policies` | `governance.manage` | `{ code, staffTypes[], title, body, originalLocale, ackFrequency, effectiveFrom }`. Translation into each staff locale is queued |
| PATCH | `/policies/{id}` | `governance.manage` | Drafts only. Published text is frozen (`409 DOCUMENT_PUBLISHED`) |
| POST | `/policies/{id}/translations/{locale}/review` | `governance.manage` | Marks a machine translation human-reviewed |
| POST | `/policies/{id}/publish` | `governance.manage` | Freezes the text and stamps `contentHash` |
| POST | `/policies/{id}/versions` | `governance.manage` | New draft version cloned from the current one |
| GET | `/policies/due` | self | What *I* must acknowledge now (daily checklists, new versions) |
| GET | `/code-of-ethics` · POST · `/{id}/publish` | `governance.read` / `governance.manage` | Same lifecycle |
| GET | `/privacy-agreements` · POST · `/{id}/publish` | `governance.read` / `governance.manage` | Type, lawful basis, purposes, data categories, surveillance scope (with excluded zones), retention |
| POST | `/acknowledgments` | self | `{ policyId \| codeOfEthicsId \| privacyAgreementId, documentVersion, contentHash, locale, method, typedName?, signatureFileId?, witnessId? }`. The server stamps the time. The hash must match the text served |
| POST | `/acknowledgments/{id}/withdraw` | signer | `{ reason }`. Only for withdrawable consents (PDPL); otherwise `422` |
| GET | `/acknowledgments` | self / `governance.acknowledgments.read` | Filters: document, member, `withdrawn=true`, `missing=true` (who has *not* signed) |
| GET | `/acknowledgments/export?documentId=` | `governance.acknowledgments.read` | PDF evidence pack: text in the signer's language, hash, timestamp, method |

## 10. Petty cash

> **Status: implemented** in `apps/api/src/petty-cash/`, with e2e tests in `apps/api/test/ops.e2e.test.ts`. Every endpoint in this table exists. The database enforces balance, float limit, overdraft, the receipt threshold, custodian-only logging, and review by managers only. Responses include `lowBalance`.
>
> Not yet implemented: posting approved expenses to the ledger, and turning a rejected expense into a payroll deduction. Both wait for the accounting module.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/petty-cash` | `finance.pettycash.read` | Custodians see their own float |
| POST | `/petty-cash` | `finance.pettycash.manage` | `{ custodianId, floatLimit, receiptRequiredOver, lowBalanceAlert, financialAccountId? }` |
| PATCH | `/petty-cash/{id}` | `finance.pettycash.manage` | Limits, custodian handover, deactivate. The balance is never writable |
| GET | `/petty-cash/{id}/logs` | `finance.pettycash.read` | Includes `balanceAfter` per row |
| POST | `/petty-cash/{id}/expenses` | custodian (`finance.pettycash.log`) | `{ amount, description, merchant?, receiptId?, vehicleId?, workOrderId?, tripId?, geo? }`. Lands as `PENDING_REVIEW`. `422 RECEIPT_REQUIRED` / `422 INSUFFICIENT_FLOAT` |
| POST | `/petty-cash/{id}/returns` | custodian | Hands unused cash back |
| POST | `/petty-cash/{id}/top-ups` | `finance.pettycash.manage` | Refuses to go beyond `floatLimit`. Optionally posts a TRANSFER from the source account |
| POST | `/petty-cash/{id}/adjustments` | `finance.pettycash.manage` | Signed amount and a mandatory reason (count variance) |
| POST | `/petty-cash/logs/{logId}/review` | `finance.pettycash.manage` | `{ decision: APPROVED \| REJECTED, categoryId? }`. On approval, posts to the ledger. A rejection can create a payroll deduction |
| POST | `/petty-cash/{id}/reconcile` | `finance.pettycash.manage` | `{ countedCash }` → variance, then an ADJUSTMENT |

## 11. Work orders

> **Status: implemented** in `apps/api/src/work-orders/`, except `POST /maintenance-tickets/{id}/work-order`, which waits for the property module.
>
> Translation rules:
> * Instructions are stored in the creator's language. Their status is computed from the assignee's (or the staff pool's) preferred language: `ORIGINAL_ONLY`, `PENDING`, or `HUMAN_REVIEWED` when the creator supplies `translations`.
> * A safety-critical instruction that still needs translation **defers the assignment**. The response carries a warning naming the instructions and languages.
>
> Assignee rules (database-enforced):
> * Assignees may only move the order to IN_PROGRESS, ON_HOLD or COMPLETED, set `actualCost`, and tick instructions off.
> * Instructions marked `requiresPhoto` need a photo.
> * COMPLETED requires every instruction done, and only the requester or a manager can VERIFY.
>
> No machine-translation engine is wired in yet. PENDING instructions are shown in the original language until a translation is added.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/work-orders` | `workorders.read` | Staff see what is assigned to them. Filters: status, assignee, category, due |
| POST | `/work-orders` | `workorders.create` | `{ title, description, category, priority, assigneeId? \| assigneeStaffType?, propertyId?, vehicleId?, tripId?, dueAt?, instructions: [{ text, isSafetyCritical?, requiresPhoto? }] }`. Returns `number` (WO-0007) |
| GET | `/work-orders/{id}` | party / `workorders.read` | Instructions resolved to the viewer's language with a `translated` flag and the original text |
| PATCH | `/work-orders/{id}` | requester / assignee / manage | Assignees may change only `status` (up to COMPLETED) |
| POST | `/work-orders/{id}/assign` | `workorders.manage` | `422 TRANSLATION_REVIEW_REQUIRED` while a safety-critical instruction is unreviewed |
| POST | `/work-orders/{id}/verify` | requester / manage | `{ rating 1–5, comment? }` |
| POST | `/work-orders/{id}/instructions` · PATCH `/…/{seq}` | requester / manage | Add or edit instructions. Assignee: `{ completed, photoFileId?, note? }` |
| POST | `/work-orders/{id}/instructions/{seq}/translations/{locale}/review` | `workorders.manage` | Human review of a machine translation |
| POST | `/maintenance-tickets/{id}/work-order` | `property.manage` | Spawns a work order from a property ticket |

## 12. Family travel

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/trips` | `travel.read` | Passengers see trips they are on |
| POST | `/trips` · PATCH `/trips/{id}` | `travel.manage` | `{ title, purpose, startDate, endDate, destinations[], budget? }` |
| GET | `/trips/{id}/checklist` | `travel.read` | Computed readiness: passport validity ≥ 6 months, visas, exit/re-entry for staff, bookings confirmed, cancellation deadlines |
| POST | `/trips/{id}/passengers` · DELETE `/…/{pid}` | `travel.manage` | `{ membershipId \| staffId \| guestName, passengerType, passportDocumentId?, visaStatus, exitReentryRequired }`. Adding a staff passenger can raise a `LEAVE`/exit-re-entry request |
| GET | `/trips/{id}/bookings` · POST · PATCH `/…/{bid}` | `travel.read` / `travel.manage` | `{ type, provider, confirmationRef, from, to, startAt, endAt, passengerIds[], amount?, cancellationDeadline? }` |
| POST | `/trips/{id}/bookings/{bid}/pay` | `travel.manage` | Posts a transaction and links it |
| GET | `/trips/{id}/itinerary?format=pdf\|ics` | `travel.read` | Day-by-day itinerary in the viewer's language. `.ics` for calendars |

## 13. Cross-cutting

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/files` | member | `{ entityType, entityId, fileName, mimeType, size }` returns a pre-signed upload |
| GET | `/files/{id}/url` | per entity | Short-lived signed GET; a sensitive file is audited |
| DELETE | `/files/{id}` | uploader / manage | |
| GET | `/reminders?status=PENDING` | member | |
| POST | `/reminders/{id}/ack` · `/snooze` | recipient | |
| GET | `/notifications` · POST `/notifications/read` | self | |
| GET | `/dashboard` | member | Role-aware widgets: head = cash, approvals, expiries; maid = tasks, payslip, requests; driver = vehicle, trips, fuel card balance |
| GET | `/search?q=` | member | Global search across permitted entities (pg_trgm, Arabic-normalised) |
| GET | `/sync?since=<cursor>` · POST `/sync` | member | WatermelonDB pull/push protocol for offline mobile (tasks, trips, fuel, receipts, attendance) |
| POST | `/ai/ask` | member | Natural-language question over permitted data (runs under the same RLS context) |
| POST | `/translate` | member | `{ text, to }` translates a staff chat or request message |

## 14. Realtime & webhooks

**WebSocket** `wss://api…/v1/realtime`. After auth, the socket joins rooms `household:{id}` and `membership:{id}`. Events are filtered server-side by permission:

`request.created` · `request.decided` · `approval.pending` · `policy.due` · `acknowledgment.withdrawn` · `pettycash.low_balance` · `pettycash.expense_pending` · `workorder.assigned` · `workorder.completed` · `trip.checklist_failed` · `transaction.posted` · `receipt.extracted` · `budget.threshold` · `reminder.due` · `task.assigned` · `task.completed` · `trip.started` · `card.frozen`

**Inbound webhooks** (HMAC-signed, idempotent on provider event id):

| Path | Source |
|---|---|
| `POST /webhooks/bank/{provider}` | Open-banking transaction feed |
| `POST /webhooks/cards/{issuer}` | Card authorisations: real-time limit checks and push "Ahmed spent 45 SAR at Jarir" to the guardian |
| `POST /webhooks/whatsapp` | Staff replies and requests via the WhatsApp bot |
| `POST /webhooks/ocr/{provider}` | Async OCR completion → `processReceiptImage` merge (ZATCA QR authoritative) |
| `POST /webhooks/billing` | Subscription events |

## 15. Example

```http
POST /v1/requests
Authorization: Bearer eyJ…
X-Household-Id: 7c1e…
Accept-Language: tl
Idempotency-Key: 4b0c…

{ "type": "SALARY_ADVANCE", "title": "Pambayad sa ospital ng nanay ko",
  "amount": { "amount": "800.00", "currency": "SAR" },
  "payload": { "installments": 4 }, "priority": "HIGH" }
```

```http
201 Created
{ "id": "a91f…", "status": "IN_REVIEW", "title": "Pambayad sa ospital ng nanay ko",
  "titleTranslations": { "ar": "مصاريف مستشفى والدتي" },
  "approvals": [ { "step": 1, "approver": { "displayName": "أم أحمد" }, "decision": "PENDING" } ],
  "createdAt": "2026-11-04T09:12:44Z" }
```
