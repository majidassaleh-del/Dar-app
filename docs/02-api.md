# Household ERP: Core API (REST `/v1`)

The API is REST + JSON, specified as OpenAPI 3.1, with request and response types generated from the shared Zod schemas in `packages/contracts`. GraphQL was considered and rejected for v1. Per-row RLS and permission scopes are simpler to reason about with fixed resource endpoints. Mobile offline sync is served by a dedicated `/sync` endpoint instead.

## 0. Multi-tenancy and data protection

> **Status: enforced and tested.** The database layer is tested in `tests/rls_test.sql` section 17 (plus 1–16). The HTTP layer is tested in `apps/api/test/tenancy.e2e.test.ts`. Both run on every commit (`scripts/verify.sh`) and in CI.

### 0.1 Tenant model

* **Household = tenant.**
  * Every household has a UUID and a unique slug (for example `efa`, `afa`).
  * Every business entity has a `"householdId" NOT NULL` with a foreign key to `households`. That covers staff, contracts, payroll, salary payments, advances, documents, files, vehicles, fuel, petty cash, accounts, transactions, ledger, budgets, requests, work orders, reminders and notifications.
  * That is **71 tables**, checked automatically. `audit_logs` is the one exception: it may also hold user-level events that have no household, and nobody can read those rows through the API.
* **People.**
  * A *user* is a login identity (phone and email) and holds no household data itself.
  * A *membership* binds a user to one household with one role. A user who works for several households has one membership per household; for example, the EFA office serving both the EFA and AFA families.
* **One household per request.**
  * The household comes from `X-Household-Id`. The database accepts it only if the caller has an active, unexpired membership there (`app.current_household_id()`). Otherwise it resolves to nothing, and the request sees no rows.
  * A multi-household member therefore works in one household at a time. No endpoint, filter or query can combine or compare data of two households, whatever the role, Head and EFA office included.
* **Errors.** A non-member gets `404`, not `403`, so the response doesn't reveal whether the household exists.

### 0.2 Enforcement layers

| Layer | What it guarantees |
|---|---|
| Runtime roles | The API connects as `herp_api` (no BYPASSRLS, no table privileges) and works only through `SET LOCAL ROLE app_user` in a per-request transaction (`PrismaService.withRls`). The worker uses `app_service` (BYPASSRLS) and must filter by `householdId` itself. |
| Row-level security | Every table has `FORCE ROW LEVEL SECURITY`, so it applies to the table owner as well. Each household table has the `tenant_isolation` policy (`USING` and `WITH CHECK` on the current household); a write aimed at another household is refused. On top of that come restrictive per-role policies (ALL / OWN / ASSIGNED / WARDS). |
| Reference isolation | Every foreign key between tenant tables, plus uuid arrays and uuid columns without an FK (162 triggers), must point to a row of the **same** household (`app.enforce_same_household`). Polymorphic references (`attachments.entityId`, `reminders.entityId`, `sync_operations.entityId`) are validated the same way. |
| SECURITY DEFINER functions | These bypass RLS, so they're the main leak risk.<br>• A request may execute only 32 reviewed functions. Each is scoped to the caller's household, user or membership, or through `app.tenant_ok()`, which during a request answers only for the caller's own household.<br>• Internal mutators (`post_journal`, `ensure_chart_of_accounts`, `fulfil_request`, `ledger_account`, `route_request_rows`, `reverse_entry_internal`) cannot be called by a request at all; they run only inside owner-run triggers or the worker.<br>• A new definer function fails the DB suite until it is reviewed and added to the list. |
| No views | Views run with their owner's rights; the suite fails if one appears. |
| Encryption keys per household | Field and file encryption use a per-household data key (KMS envelope, `tenant_keys`), so ciphertext from one household cannot be decrypted with another's key. |

**Tests that guard this:**
* **DB suite, section 17:**
  * A static check of all 71 tables (FORCE RLS, isolation policy, NOT NULL, FK).
  * A sweep of 8 role/household contexts across every tenant table, expecting 0 foreign rows. It includes a member of both households and a forged household header.
  * Cross-household writes are refused.
  * Definer helpers return nothing for another household's IDs.
  * Internal mutators are not callable.
* **HTTP gate:** every GET route the API registers is found at runtime (72 today) and called as another household's Head. The by-ID routes are called with every H1 ID. No response may contain an identifier of the first household, whatever its status code.

### 0.3 Developer and DBA access: what is protected and how

**Encrypted at rest:**
* **Columns** (AES-256-GCM, per-household key wrapped by Cloud KMS; only the API, holding KMS decrypt permission, can read them):
  * Iqama, passport and visa numbers.
  * Border numbers.
  * Bank IBANs, and workers' payout IBANs (with a blind index and last 4 for search and display).
  * The lease counterparty ID.
  * Health conditions and allergies.
  * Medical restrictions.
* **Files:** sensitive staff files (passport and iqama scans, medical reports, sick-leave certificates) are encrypted with the same household key before storage.
* **Authentication secrets:** authenticator (TOTP) secrets are encrypted with an application key. One-time codes and unlock nonces are stored only as HMACs.
* A database administrator who can read the tables sees only ciphertext for all of these. Decrypting needs separate KMS permission.

**Protected by RLS but stored in plain text:**
* **What:** names, wages and payroll lines, salary payments, advances, ledger and transactions, petty cash, budgets, vehicles and receipt extractions.
* **Why:** the database enforces the money rules on these values with SQL arithmetic. That covers the Art. 9 deduction cap, balanced journals, float limits, budget totals and payroll totals. Encrypting the columns would move those guarantees out of the database.
* **Consequence:** RLS stops every application path and every API user, but **not** a PostgreSQL superuser, the schema owner, or the worker role (BYPASSRLS). Someone with that access can read these values.

So "developers cannot see household data" holds for the encrypted fields. For wages and financial records it depends on production access controls, which are deployment configuration, **not** something this repository can enforce:
* No standing human access to the production database: break-glass only, through IAM with approval, time limits and audit.
* `pgaudit` / Cloud SQL audit logs on.
* Database, KMS and storage permissions held by different principals, so database access alone never decrypts.
* Customer-managed encryption keys for disks and backups.
* The worker's credentials kept in Secret Manager.

If wages and amounts must also be unreadable to administrators, application-level encryption of those columns is possible. The cost is moving the payroll and ledger rules out of the database; that would be a separate design decision.

---

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

## 2a. Onboarding and daily unlock (`/auth`)

> **Status: implemented** in `apps/api/src/auth/` (with client logic in `packages/offline/src/device-unlock.ts` and the Expo wiring in `apps/mobile/src/auth/`). Tests: `apps/api/test/auth.e2e.test.ts` (including RFC 6238 vectors), `packages/offline/test/device-unlock.test.ts` and DB-suite section 16. **Not tested against a live SMS or email gateway, and not on a real phone.**

**First-time onboarding (once per user):**
1. SMS OTP to the phone.
2. Email OTP.
3. An authenticator app (TOTP, compatible with Microsoft Authenticator).

Until all three are verified, every endpoint except `/auth/*` answers **403** "complete onboarding first" (`OnboardingGuard`). The verified phone and email become the user's login identifiers.

**Daily unlock:**
* The app holds a P-256 key whose private half is released only by Face ID / Touch ID.
* It signs a server nonce and receives a **device-session token**, valid until 04:00 Riyadh (one unlock a day).
* With `AUTH_REQUIRE_DEVICE_SESSION=true` (the production default), every non-auth route requires that session token. The identity provider's token alone gets 401 "unlock the app first".
* Revoking a device ends its sessions within 30 s.

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/onboarding` | `{ phone, email, authenticator, complete, next }` (masked values) |
| POST | `/auth/onboarding/phone` · `/phone/verify` | `{ phone }` (E.164) → `{ challengeId, expiresAt }`; then `{ challengeId, code }`. 6-digit code, 5 minutes, at most 5 attempts (then locked), at most 5 codes per hour (429) |
| POST | `/auth/onboarding/email` · `/email/verify` | The same, by email |
| POST | `/auth/onboarding/totp` | After phone and email are verified: returns `otpauthUri` (QR) and `secret`. It can be restarted until confirmed |
| POST | `/auth/onboarding/totp/verify` | `{ code }`: confirms enrolment; `complete` becomes true |
| POST | `/auth/devices` | `{ deviceId, publicKeyJwk (P-256), label?, totpCode }`. Requires onboarding, a fresh sign-in (≤ 10 min) and an authenticator code |
| GET · DELETE | `/auth/devices` · `/auth/devices/{id}` | List and revoke this user's devices |
| POST | `/auth/unlock/challenge` | `{ deviceId }` → `{ challengeId, nonce, message }` (2 minutes) |
| POST | `/auth/unlock` | `{ challengeId, nonce, signature }`. ECDSA P-256/SHA-256 over `message`; raw (WebCrypto) or DER (iOS / Android) signatures are accepted. Returns `{ token, expiresAt, deviceKeyId }` |
| POST | `/auth/unlock/totp` | Fallback when biometrics changed: fresh sign-in + `{ deviceId, code }` → the same session |

**Security properties (database-enforced unless noted):**
* **Codes and nonces.** Stored only as HMACs. `app.consume_auth_challenge` enforces single use, expiry and 5 attempts. It returns a status instead of raising, and the API refuses only after commit, so failed attempts always count.
* **Factor rows.** A user cannot set their own factors, edit a challenge, change phone or email without verifying, or register a device key before onboarding. Challenges are private to their user, including from the Head.
* **Authenticator.**
  * The secret is AES-256-GCM encrypted (`AUTH_TOTP_KEY`).
  * A time step is accepted once (replay → 422).
  * Five wrong codes lock the factor for 15 minutes (429).
  * Enrolment cannot be swapped once confirmed.
* **Sessions.** HS256 with `SESSION_SIGNING_SECRET`, bound to the device key, and checked against revocation.
* **Production configuration.** Production refuses to start without `AUTH_TOTP_KEY`, `SESSION_SIGNING_SECRET` and `OTP_WEBHOOK_URL`, the SMS/email gateway that receives `{ channel, to, text }`.
* **Known limit.** On Expo the private key sits in the Keychain / Keystore behind biometrics, not inside the Secure Enclave; a native signing module can move it there without server changes.

## 3. Staff HR

> **Status: implemented**: everything in this section. Code is in `apps/api/src/staff/`, with e2e tests in `apps/api/test/staff.e2e.test.ts` and `hr.e2e.test.ts`. Notes on the implementation:
> * **Attendance.** Workers check in and out for *today* (household time zone), once each, with server-stamped times. Only `staff.payroll.manage` can correct a day (`PUT /attendance/{staffId}/{date}`).
> * **Leave.** Leave is requested with `POST /requests {type: "LEAVE", leaveType, startDate, endDate}`. Final approval creates the `LeaveRecord` in the database, and the request becomes `FULFILLED`. Filing for another worker needs `staff.payroll.manage`. `GET /staff/{id}/leave-balance?asOf=&year=` returns the Art. 10 leave position (see §3b).
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
| GET | `/staff/{id}/leave-balance?asOf=&year=` | `staff.payroll.read` | Art. 10 accrual, vested days, balance, unused-leave payout (§3b) |
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

## 3a. Staff HR extension: files, health, handover, evaluations, training

> **Status: implemented** in `apps/api/src/files/` and `apps/api/src/hr/`. E2E tests are in `apps/api/test/hrx.e2e.test.ts`; attack tests are in the DB suite (section 11).

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/files` | uploader | `{ entityType, entityId, fileName, mimeType (pdf, jpeg, png, heic, webp), sizeBytes ≤ 15 MB, sha256, staffId?, category? }`. Categories: `PASSPORT, IQAMA, DRIVING_LICENSE, ACADEMIC_CERTIFICATE, EMPLOYMENT_CONTRACT, MEDICAL_REPORT, SICK_LEAVE_CERTIFICATE, TRAINING_CERTIFICATE, OTHER`. Passport, iqama, licence and medical files are **sensitive and encrypted at rest** (household DEK, bound to the file id) |
| PUT | `/files/{id}/content` | uploader | Raw bytes (`application/octet-stream`). Size and sha256 must match the declaration. Immutable after upload |
| GET | `/files/{id}/url` | can see the file | Signed link valid 60 s (sensitive) or 300 s. The link names the requester and is **re-checked under RLS** on download. Sensitive downloads are audited (`VIEW_SENSITIVE`) |
| GET | `/staff/{id}/files?category=` | per file | The worker sees her own files. Medical files need `staff.health.read` |
| GET · PUT | `/staff/{id}/health` | `staff.health.read` / `.manage` (worker: own) | Blood type, disclosed **conditions and allergies (encrypted)**, medical status, checkups and sick-leave history. Head and EFA only; **not the spouse** (need-to-know) |
| POST | `/staff/{id}/medical-checkups` · PATCH `/medical-checkups/{id}` | `staff.health.manage` | `{ checkupDate, validUntil? (default +1 year), result, clinicName?, restrictions? (encrypted), reportAttachmentId? }` |
| GET | `/compliance/staff` | `staff.health.read` | Per worker: medical status (`VALID`, `DUE_SOON`, `OVERDUE`, `MISSING`), open and overdue handovers, trainings expiring |
| GET · POST | `/staff/{id}/handovers` | read / `staff.profile.manage` | Issue keys, phones, cards, uniforms and equipment `{ itemType, description, serialOrTag?, quantity?, vehicleId?, cardId?, conditionOut?, expectedReturnAt? }` |
| POST | `/handovers/{id}/acknowledge` | **the worker only** | Digital sign-off. Stores a sha256 of what was signed. Issued details are then frozen |
| POST | `/handovers/{id}/return` · `/lost` | `staff.profile.manage` | A lost item needs a note |
| GET · POST | `/staff/{id}/evaluations` | read / manage | Scores 1–5 for punctuality, quality, conduct, safety and communication; `overall` is computed. The worker can't see drafts |
| POST | `/evaluations/{id}/share` · `/acknowledge` | manager / **the worker** | A shared evaluation is final. Only the worker acknowledges, once, with an optional comment |
| GET · POST | `/staff/{id}/trainings` · POST `/trainings/{id}/acknowledge` | read / manage / worker | Training and safety log (first aid, fire, child safety, food hygiene, defensive driving, equipment…). `validUntil` drives refresher reminders |

**Database rules:**
* **Mandatory annual medical checkup for every staff role.** A worker can't become ACTIVE (on insert, or from RECRUITING, ON_PROBATION or ABSCONDED) without a FIT or FIT_WITH_RESTRICTIONS checkup valid today. UNFIT doesn't count.
* **Exit clearance.** No TERMINATED or FINAL_EXIT while items are PENDING_ACK or ISSUED.
* **Sick leave** over one day needs a `certificateAttachmentId`, which must be a `SICK_LEAVE_CERTIFICATE` file *of that worker*.
* **Polymorphic references are now checked.** `attachments.entityId` and `reminders.entityId` must exist in the same household, and a staff file must belong to the same worker as its target.
* **Reminders** (`node dist/worker.js reminders:sync`):
  * medical checkup due for **every worker** at 60/30/15 days, then overdue (no checkup ever: hire date + 30 days);
  * training refreshers at 60/30/15 days;
  * item returns at 7 and 1 days, then overdue.

## 3b. Saudi domestic labour compliance (لائحة عمال الخدمة المنزلية ومن في حكمهم)

> **Status: implemented** in `apps/api/src/hr/esb.ts`, `hr/labor.controller.ts` and `staff/payroll.controller.ts`, plus DB rules in `prisma/rls.sql` (section *SAUDI DOMESTIC LABOR COMPLIANCE*). Tests: `apps/api/test/labor.e2e.test.ts` and DB-suite section 15.
>
> **Legal note:** the rules follow Council of Ministers Decision 310 of 7/9/1434H as summarised in published sources; the official text could not be retrieved while building this. The Art. 16 wording is read two ways (see below), so the end-of-service rule is configurable per contract. Have the household's legal adviser confirm the chosen rule.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/staff/{id}/end-of-service?asOf=` | `staff.payroll.read` (workers: their own) | Service start/end, unpaid days excluded, completed 4-year periods, `monthlyWage`, `vested` (owed if the contract ended that day), `provision` (accrual), `nextVestingDate`, monthly snapshots |
| GET | `/hr/end-of-service?asOf=` | Head / EFA | Every current worker, with `totalVested` and `totalProvision` (the household's ESB liability) |
| GET | `/staff/{id}/leave-balance?asOf=` | `staff.payroll.read` (workers: their own) | Art. 10: `daysPerYear` (statutory 15, i.e. 30 per 2 years; contracts may grant more), `accruedDays`, `takenDays` (paid ANNUAL / VACATION_TRAVEL), `balanceDays`, `completedTwoYearCycles`, `vestedDays`, `availableNowDays`, `nextEntitlementDate`, `dailyRate` (monthly wage / 30), `unusedLeavePayout` |
| GET | `/staff/{id}/final-settlement?asOf=` | `staff.payroll.read` | If the contract ended that day: ESB vested + unused leave at (monthly wage / 30) × days = `totalDue`. Outstanding advances are shown separately (`totalAfterAdvances`); recovering them from the settlement needs the worker's agreement and is not deducted automatically |
| GET | `/me/advances` | the worker | `totalGranted`, `totalRepaid`, `currentOutstanding`, `openAdvances`. Per advance: instalment, installments left, `recoveries` (paid runs) and `scheduled` (approved runs) |
| GET | `/staff/{id}/advances` | `staff.payroll.read` | The same, for the office |
| — | worker `esb:accrue [YYYY-MM]` | service | Monthly `esb_accruals` snapshot per worker (idempotent): vested, provision, and the change since the previous month (`delta`, for the books; about monthly wage / 48, and the deltas always sum to the rounded provision). Users cannot write it (DB) |

**End-of-service (Art. 16):**
* **Strategy.** Set per contract with `endOfServiceRule`:
  * `SA_DOMESTIC` (**default; confirmed by the household on 2026-11-04 as its primary ESB strategy**): one month's wage for every completed period of 4 consecutive years.
  * `SA_DOMESTIC_SINGLE`: one month's wage, once, after 4 consecutive years.
  * `SA_LABOR_LAW`: for contracts that grant the general Labor Law formula. That is half a month per year for the first 5 years and a month per year after, pro rata. The Art. 85 resignation reductions are not applied.
* **Liability provisioning.** Monthly wage / 48 for every completed month of service, so the provision equals one month's wage exactly when a 4-year period vests. `SA_LABOR_LAW` stays a contract-level override, provisioned at its own rate.
* **Wage basis.** The last contractual monthly wage: basic salary plus fixed allowances.
* **Service.**
  * Counted along the latest unbroken chain of contracts; a gap of more than one day breaks it.
  * Unpaid leave is not service, so it moves the vesting date.
  * A 4-year period completes at the end of the day before the anniversary.

**Leave (Art. 10):**
* **Entitlement.** 30 paid days for every 2 completed years of service, accruing at 15 days a year, unless the contract grants more. `annualLeaveDays` is days per year: default 15, with a minimum of 15 enforced in the API and by a DB check (`employment_contracts_art10_min_leave`).
* **Cycles.** A cycle completes at the end of the day before the 2-year anniversary; unpaid leave pushes it back.
* **Taken.** Paid ANNUAL and VACATION_TRAVEL days count as taken. Leave taken before it vests is the employer's choice: it shows as negative `availableNowDays` and lowers the exit payout.
* **Unused leave at exit.** Paid at (monthly wage / 30) × unused (accrued − taken) days, in halalas, half-up.

**Payroll rules:**
* **Unpaid leave.** Its own `UNPAID_LEAVE` line of (monthly wage / 30) × unpaid days, where the monthly wage is basic plus allowances. It is computed in halalas and rounded half-up, whatever the month's length. Half days are supported.
* **Art. 9 cap.** Deductions (manual `DEDUCTION` lines plus salary-advance recovery) may not exceed half of the wage earned that month; the wage earned is earnings less unpaid leave.
  * Payroll generation limits advance recovery to that headroom.
  * The database refuses any line that breaks the cap (422, a statement-level trigger on `payroll_lines`).
* **Art. 11 sick leave.** At most 30 days of paid sick leave in any 12 months, with a medical report; the report is already required above one day. A sick leave that goes beyond is split automatically: the paid part stays, and the excess becomes unpaid leave, which payroll deducts.

**Salary acknowledgment:**
* Recording a salary payment (single or from a payroll run) schedules three reminders to the worker: when paid, after 3 days and after 7 days. Each goes on WhatsApp (template `herp_salary_acknowledge`), push and in-app, in the worker's language, with a deep link to `POST /salary-payments/{id}/acknowledge`.
* Acknowledging, disputing or reversing the payment removes the outstanding reminders.
* A worker without an app account gets none.
* **Not yet modelled:** working-hour and rest-day limits, the return air ticket, and posting ESB provisions and the final settlement to the ledger.

## 4. Household accounting

> **Status: implemented** in `apps/api/src/banking/`: accounts, cards, categories, transactions, budgets, recurring bills, plus funding-clearing reconciliation (below). E2E tests are in `apps/api/test/banking.e2e.test.ts`; the attack tests are in the DB suite.
>
> **Accounts and the ledger**
> * Every account gets its own ledger account (12xx assets, 22xx cards and loans). A non-zero `openingBalance` is posted against 3100 Owner's equity.
> * `balance` (`currentBalance`) uses one sign: asset value. A card's debt is negative. Type, currency, opening and current balance are not writable through the API (column grants).
>
> **Transactions**
> * `EXPENSE` posts Dr the category's mapped account (else 6200) / Cr the account. `INCOME` posts Dr the account / Cr the mapped income account (else 4900). `TRANSFER` posts Dr counter / Cr account.
> * Posting happens on insert as POSTED, or on PENDING → POSTED. Money fields and category are frozen afterwards. `/reverse` is the only correction: it restores the balance and mirrors the ledger entry, once.
> * Who can record: staff and dependents only `EXPENSE`, with **their own card** or the **cash box they hold**. `source` RECURRING / BANK_FEED / SYSTEM is reserved for workers.
> * Card rules, applied by the DB to every insert from anyone: account match, ACTIVE status, expiry, allowed categories, and per-transaction, daily and monthly limits in household-local days.
> * Category kind must fit the type, and the currency must equal the household's (multi-currency is not supported yet).
>
> **Cards:** holders see their own card and can **freeze** it, but not unfreeze it or change limits.
>
> **Budgets:** `spent` covers posted bank and card expenses plus approved petty-cash expenses, across the category's whole subtree, in the current period. A personal budget (`ownerId`) counts only that member's spending. Responses include `percentUsed`, `alert` and `overBudget`. Rollover isn't computed yet.
>
> **Recurring bills:** the JSON template's references are validated against the household by the DB. The worker `node dist/worker.js recurring:run` posts one transaction per due occurrence, catching up at most 12, idempotent via `externalRef = recurring:<rule>:<date>`. A failing bill (for example, a card limit) is reported and retried, never skipped.
>
> **Not built yet:** `/transactions/import` (CSV/OFX), open-banking `bank-link`, `/accounts/{id}/top-up`, `/reports/*`.

### 4.1 Owner funding clearing (reconciliation)

Petty-cash top-ups, salary payments and salary advances credit **1190 Owner funding clearing**, because the platform doesn't know which bank paid them. Record the bank side as a **funding** transaction: `POST /transactions { type: "TRANSFER", isFunding: true, accountId, amount }`, which posts Dr 1190 / Cr bank. Then match it to the clearing entries it paid for.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/funding-clearing` | `finance.ledger.read` | `clearingBalance` (1190), `openItems` (entries crediting 1190 with `remaining`), `unmatchedFunding` |
| GET | `/transactions/{id}/funding-suggestions` | `finance.ledger.read` | Open items, exact-amount matches first, then nearest date |
| POST | `/transactions/{id}/funding-matches` | `finance.ledger.manage` | `{ matches: [{ journalEntryId, amount }] }`. The DB caps each match at both the item's and the transaction's remaining amount |
| DELETE | `/transactions/{id}/funding-matches/{matchId}` | `finance.ledger.manage` | Unmatch |

A matched funding transaction, or a matched clearing entry (such as the salary payment behind it), cannot be reversed until it is unmatched.

### 4.2a Bank statement import (CSV / OFX)

> **Status: implemented.** The parser is `packages/bank-statements` (no dependencies). The API is `apps/api/src/banking/statements.controller.ts`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/accounts/{id}/statements` | `finance.accounts.manage` | `{ fileName, content, encoding?: utf8\|base64, format?: CSV\|OFX, dateOrder?: DMY\|MDY }`. Parses, stores the lines and auto-matches them. The same file twice → `409`. Lines already imported from an overlapping statement are skipped (`duplicatesSkipped`) |
| GET | `/accounts/{id}/statements` · `/statements/{id}` | `finance.accounts.read` | Import summary (matched / unmatched / created / ignored) and lines |
| POST | `/statements/{id}/lines/{lineId}` | `finance.accounts.manage` | `{ action: match, transactionId }` · `{ action: unmatch }` · `{ action: ignore }`. The DB refuses a match on another account or with a different signed amount (`422`) |
| POST | `/statements/{id}/apply` | `finance.accounts.manage` | Unmatched lines become `BANK_FEED` transactions. Per-line overrides: `categoryId`, `isFunding` (owner funding), or `counterAccountId` (internal transfer). **Every matched or created transaction becomes RECONCILED.** Returns `balanceCheck`: bank closing vs book balance on the last statement day. Final once applied |

**Parser:**
* CSV headers in Arabic or English, with up to 15 preamble rows. Delimiters `, ; tab |`.
* Debit/credit columns or a signed amount. Digits in Arabic-Indic or EU decimal format, `(…)`, CR/DR.
* `dd/mm/yyyy` by default, switching to month-first only when the data proves it.
* Newest-first exports are re-sorted.
* Running balances are checked, and the opening and closing balances derived.
* OFX 1.x SGML and 2.x XML: `STMTTRN`, `FITID`, `LEDGERBAL`, `CURDEF`.

**Matching:** exact signed amount; the bank reference wins, then same day, then ±1 and ±3 days, plus merchant words. One-to-one, greedy by score.

### 4.2b One-touch bank → petty-cash float

`POST /petty-cash/{id}/fund-from-bank { accountId, amount, description? }` runs as a single database transaction:
* a funding bank transaction (Dr 1190 / Cr bank);
* the float TOP_UP (Dr float / Cr 1190);
* the funding match between them.

The clearing account nets to zero immediately. It's all-or-nothing: a top-up over the float limit leaves the bank untouched. It needs `finance.pettycash.manage` and `finance.ledger.manage`.

### 4.2 Bank statement reconciliation

`POST /accounts/{id}/reconcile { statementBalance, asOf, transactionIds? }` computes the cleared balance: opening + already RECONCILED + selected POSTED up to the end of `asOf` (household time). If it equals the statement, the selection becomes `RECONCILED`. Otherwise nothing changes and the response carries the `difference`.


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

> **Status:** implemented in `apps/api/src/fleet/`, with e2e and unit tests in `apps/api/test/fleet.e2e.test.ts` and DB-suite section 14. Not yet implemented: trips, traffic violations and the fleet cost report (rows marked *planned*).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/vehicles` | `fleet.read` | Drivers see only their assigned vehicles |
| POST | `/vehicles` | `fleet.manage` | Make/model/year, plate (Latin and Arabic), VIN, fuel type, odometer, `registrationNumber` + `registrationExpiry` (Istimara), `insuranceProvider` / `insurancePolicy` / `insuranceExpiry`, `inspectionExpiry` / `lastInspectionAt` / `inspectionCenter` (Fahas), `tankCapacityL`, `expectedKmPerL` |
| PATCH | `/vehicles/{id}` | `fleet.manage` | Drivers are refused (DB trigger `vehicles_0_guard`), so they cannot change insurance or plate details |
| GET | `/vehicles/{id}` | `fleet.read` | Profile with days left per document, current drivers, maintenance plans with status (`OK` / `DUE_SOON` / `OVERDUE`) and the last fill-ups |
| POST | `/vehicles/{id}/assignments` | `fleet.manage` | `{ driverId, startsAt?, isPrimary }`. A new primary assignment ends the previous one, recording the odometer |
| GET · POST | `/vehicles/{id}/maintenance-plans` | `fleet.read` / `fleet.manage` | `{ type, intervalKm?, intervalDays?, lastDoneAt?, lastDoneKm? }`. Without history the plan starts from today's odometer and date. `nextDueKm` and `nextDueDate` are kept by a trigger |
| PATCH | `/maintenance-plans/{id}` | `fleet.manage` | Intervals, active flag |
| POST | `/vehicles/{id}/maintenance` | `fleet.manage` | Record a service. A COMPLETED one linked to a plan (explicitly or by type) resets the plan and adds an odometer reading. An inspection updates `lastInspectionAt` |
| GET · POST | `/vehicles/{id}/odometer` | `fleet.read` / `fleet.trips.log` | Readings are append-only and never go backwards (422). The vehicle's odometer follows the maximum |
| GET | `/vehicles/{id}/fuel?flagged=` | `fleet.read` | Fill-ups with km since the last fill, km/L, anomalies; summary of litres, cost, average km/L and flagged count |
| POST | `/vehicles/{id}/fuel` | `fleet.fuel.log` (assigned driver) | `{ liters, totalCost, pricePerLiter?, odometerKm, fuelType?, station?, filledAt?, receiptId?, pettyCashAccountId? }`. One transaction: odometer reading, fuel log and, when paid from the driver's float, a `PENDING_REVIEW` petty-cash expense linked to the vehicle and receipt |
| GET | `/fleet/overview` | `fleet.read` (ALL) | Documents due within 60 days, maintenance due or overdue, flagged fuel (90 days) |
| GET | `/vehicles/{id}/trips` · POST `/trips/start` · POST `/trips/{id}/end` | `fleet.read` / `fleet.trips.log` | *Planned* |
| GET | `/violations` · POST · PATCH `/violations/{id}` | `fleet.read` / `fleet.manage` | *Planned* |
| GET | `/reports/fleet?vehicleId=&period=` | `fleet.read` (ALL) | *Planned*: total cost of ownership |

**Fuel validation:**
* **Hard rules (database).** The total must equal litres × price, within 1 SAR or 2%. The odometer must not go backwards. Distance and km/L since the previous fill are derived by the trigger, not taken from the client.
* **Soft flags.** These mark the fuel log `flagged` and are written into the petty-cash entry's description, so the reviewer sees them:

| Code | Raised when |
|---|---|
| `EFFICIENCY_LOW` | km/L below 60% of the baseline (`expectedKmPerL`, else the median of the last 5 fills); usually fuel not used by the car |
| `EFFICIENCY_HIGH` | km/L above 160% of the baseline (a missed fill or a wrong reading) |
| `OVER_TANK` | litres above 105% of `tankCapacityL` |
| `REFILL_TOO_SOON` | fewer than 50 km since the last fill, and within 6 hours or more than 20% of the tank |
| `ODOMETER_JUMP` | more distance than a full tank's range |
| `FUEL_TYPE_MISMATCH` / `FUEL_ON_ELECTRIC` | wrong fuel for the vehicle |
| `PRICE_OUT_OF_RANGE` | more than 25% off the reference pump price |
| `RECEIPT_MISMATCH` | entered total differs from the scanned receipt by more than 1 SAR |

**Reminders (60/30/15 engine, `reminders:sync`):**
* Istimara, insurance and Fahas expiries, as `VEHICLE` reminders.
* Maintenance plans by date, as `MAINTENANCE_PLAN` reminders. Only tiers shorter than the interval are used; 15 days always is.
* Maintenance plans by km: one alert once the odometer is within 1,000 km of `nextDueKm`. It is anchored at `kmAlertAt` and cleared by the next service.
* These go out through the notification dispatcher as WhatsApp templates `herp_vehicle_document`, `herp_vehicle_service` and `herp_vehicle_service_km`, plus push and in-app, in all six languages.
* The Daily Pulse shows vehicle documents due within 15 days, overdue services, and fuel flagged in the last 30 days.

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

### 10a. Receipt scanner (OCR → petty-cash expense)

> **Status: implemented** in `apps/api/src/receipts/` and `packages/receipt-parser`, with e2e tests in `apps/api/test/receipts.e2e.test.ts`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/receipts?mimeType=&pettyCashAccountId=&vehicleId=` | `finance.receipts.upload` | Raw bytes (`application/octet-stream`, at most 10 MB), JPEG, PNG, WebP or PDF. The content is checked against `mimeType`, and a duplicate (same SHA-256) is refused with 409. Returns `{ receipt, expense, autoFilled }` |
| GET | `/receipts/{id}` | uploader / `finance.transactions.read` | The extraction: `merchantName`, `vatNumber`, `date`, `total`, `vat`, `source`, `needsReview`, `warnings`, `ocrError` |
| POST | `/receipts/{id}/process` | uploader / admin | Retries OCR after an outage, or once OCR has been configured |
| POST | `/receipts/{id}/expense` | custodian | `{ accountId, amount?, merchantName?, description?, occurredAt?, vehicleId?, categoryId? }`. Creates the expense from the receipt; any field may be corrected. One receipt backs at most one entry |

**How extraction works:**
* **Vision OCR.** `OCR_PROVIDER=claude` (model `OCR_MODEL`, default `claude-opus-5-5`) sends the image or PDF and receives JSON-schema output: a transcript plus the fields. Server-side refusal fallback is on.
* **Field merge.** The transcript also goes through the deterministic Arabic/English receipt parser. The two reads are merged field by field:
  * Agreement raises confidence.
  * A disagreement on money, the date or the VAT number sets `needsReview` and records a warning.
  * A field only the model read gets a confidence of 0.9.
  * Implausible values are dropped: an invalid VAT id, a non-numeric amount, or an impossible date.
* **ZATCA QR.** A QR on the receipt is decoded locally and is authoritative for seller, VAT number, date, total and VAT.
* **Sanity checks.** VAT should be 15% of the total; otherwise a warning is recorded. A receipt dated in the future or more than 90 days ago is booked today, with a warning.

**What happens next:**
* If the total can be read, the expense is created as `PENDING_REVIEW` with amount, merchant, date and `receiptId`, so the worker types nothing. The manager's review queue shows `needsReview` and the warnings.
* With no total, or something that is not a receipt, nothing is booked and the worker completes it with `/receipts/{id}/expense`.
* With no OCR provider, or during a provider outage, the receipt is stored (`UPLOADED`, `ocrError`) and can be processed later.

**Database rules:**
* OCR results are written only through `app.record_receipt_extraction`: by the uploader or an admin, and once.
* A petty-cash entry may cite only a receipt its recorder uploaded (trigger `petty_cash_logs_receipt`).

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
| GET | `/notifications?unread=true` · POST `/notifications/{id}/read` · `/notifications/read-all` | self | In-app inbox (see §13a) |
| POST | `/me/devices` · DELETE `/me/devices/{id}` | self | Register an FCM / APNs push token (upsert by token; a token bound to another account is refused) |
| GET | `/dashboard/pulse` | Head / EFA | EFA Daily Pulse (see §13b) |
| GET | `/dashboard` | member | Role-aware widgets: head = cash, approvals, expiries; maid = tasks, payslip, requests; driver = vehicle, trips, fuel card balance |
| GET | `/search?q=` | member | Global search across permitted entities (pg_trgm, Arabic-normalised) |
| GET | `/sync/pull?since=<cursor>` · POST `/sync/push` | member | Offline queue for chores and work-order instructions (see §13c); trips, fuel, receipts and attendance to follow |
| POST | `/sync/offline-key` | self, fresh sign-in | Per-device fallback key for the offline data key (see §13c) |
| POST | `/ai/ask` | member | Natural-language question over permitted data (runs under the same RLS context) |
| POST | `/translate` | member | `{ text, to }` translates a staff chat or request message |

## 13a. Multi-channel reminders (WhatsApp · push · in-app)

The 60/30/15-day sweeps (`reminders:sync`: staff documents, annual medical checkups for every worker, training refreshers, item returns) write `reminders`. `node dist/worker.js notifications:dispatch` turns each due reminder into one delivery per recipient and channel (`notifications`, unique on reminder × user × channel, so re-runs are no-ops):

* **Recipients:** the reminder's member, else the household's active Head and EFA admins.
* **Language:** each delivery is rendered from the `notify.*` ICU messages in the recipient's `preferredLocale` (`=0` means overdue). Names fall back to the household language when there is no translation.
* **Stored payloads:** each row keeps the exact provider body.
  * WhatsApp Cloud API template (`herp_document_expiry`, `herp_medical_due`, `herp_training_due`, `herp_item_return`). Languages: `tl` → `fil`; `am` → `en_US`, because Amharic template support is not confirmed.
  * FCM HTTP v1 message per registered device, with `data.deepLink` (`herp://…`).
  * In-app `{ title, body, data }`.
* **Statuses:** `SKIPPED` with a reason (no phone, no device), `QUEUED`, `SENT` or `FAILED`.
  * Failures are retried on later runs, up to 5 attempts.
  * With no provider credentials (`WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_TOKEN`, `FCM_PROJECT_ID` + `FCM_ACCESS_TOKEN`), deliveries stay `QUEUED` without spending an attempt. They go out once credentials are set.
* **Access:** members can only read their own in-app rows and set `readAt`. Inserts, deletes and other updates are for the dispatcher (service role) only.

The HTTP senders follow the published WhatsApp Cloud and FCM v1 APIs but have **not** been run against live accounts. Template names must be approved in WhatsApp Business Manager first.

## 13b. EFA Daily Pulse — `GET /dashboard/pulse`

The Pulse is for the Head and the EFA office only. Other members get 403, and non-members get 404 from the tenant guard. Every figure is read under the caller's RLS context:

| Section | Content |
|---|---|
| `payroll` | current month run status, due date and days left; previous month's unpaid workers |
| `documents` | expiring staff documents by tier (`60`/`30`/`15`/`EXPIRED`), soonest 5 |
| `medical` | workers overdue, missing (30 days after hire) or due within 30 days, with names |
| `workOrders` | by status, overdue, awaiting verification |
| `approvals` | in review, awaiting the caller |
| `pettyCash` | expenses pending review (count and amount), floats below their low-balance threshold |
| `budgets` | alert and over-budget lines with spend |
| `fundingClearing` | owner-funding clearing balance and unmatched items |
| `handovers`, `salaryDisputes`, `remindersDueNow` | counts |
| `attention[]` | `{ severity: critical·warning·info, key, count, deepLink }`, most severe first; labels are `pulse.<key>` ICU messages in all six languages |

## 13c. Offline sync and biometric unlock

**Device side (`packages/offline`, adapters in `apps/mobile/src/offline`).**
* Worker chore and instruction updates made offline go into an encrypted outbox: AES-256-GCM per op, with AAD = member + slot, so entries cannot be swapped, reordered or read without the key.
* The data key (DEK) is random per device and member. It is kept in two places:
  * The biometric vault: iOS Keychain or Android Keystore, `requireAuthentication`, this-device-only. This copy gives the daily Face ID / Touch ID unlock, which needs no network.
  * Wrapped under a per-device fallback key. The server derives that key (HMAC with `OFFLINE_KEY_SECRET`) and returns it from `POST /sync/offline-key` only within 10 minutes of a real sign-in (JWT `auth_time` / `iat`).
* If biometrics are re-enrolled, the OS destroys the vault item. One OTP sign-in unwraps the DEK and re-enrols the vault, and queued work survives.
* The Expo adapters have **not** been run on a device. The unlock and queue logic is tested with fake vaults.

**`POST /sync/push`** `{ deviceId, ops: [{ opId, kind, entityId, baseVersion, clientAt, data }] }`, up to 100 ops, answered in order.
* Kinds:
  * `TASK_UPDATE`: `status` TODO / IN_PROGRESS / DONE, `proofPhotoUrl`.
  * `INSTRUCTION_COMPLETE`: `note`, `photoStorageKey`. `completedAt` = `clientAt`, capped to now and at most 7 days back.
* Each op runs in its own RLS transaction, so the online rules apply unchanged (assignee-only edits, photo-required instructions).
* Results:
  * `APPLIED { version }`.
  * `CONFLICT { version, server }`: someone else changed the row after `baseVersion`. Versions produced by the member's own earlier ops count as seen, so a chain of offline edits applies in order.
  * `REJECTED { problem }`: a 403 or 422 from the database, or 404 when the row is not visible.
* Idempotent on (member, `opId`): a replay returns the stored outcome with `replayed: true`.
* Outcomes are kept in `sync_operations`. The table is append-only and readable only by the member, and its entity must belong to the same household (DB trigger).

**`GET /sync/pull?since=`** returns the caller's own chores (as assignee) and the instructions of work orders assigned to them, changed after `since`, each with `version`.
* `version` and `updatedAt` are maintained by a trigger (`app.bump_row_version`). Clients cannot set them, and no-op updates do not bump them.
* The returned `cursor` overlaps by 2 minutes, so late commits are not missed. Clients merge by `version`.
* Hard-deleted chores are not tombstoned yet: clients should do a full pull (no `since`) on login.

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

## 16. Web: EFA Private Office executive UI

**Stack (`apps/web`):**
* **Tailwind CSS v4.** CSS-first config in `src/app/globals.css`, `@tailwindcss/postcss`.
* **shadcn/ui.** Card, Badge, Button and Table in `src/components/ui/` are copied in and re-themed with the tokens below; no slate/navy classes remain.
* **Tremor Raw.** BarList and ProgressBar in `src/components/tremor/`. The progress fill is an emerald→gold gradient that fills from inline-start; there is also a `gold` variant.

**Identity:**
* **Palette.** Deep Royal Emerald `#064e3b` / `#022c22`, Warm Platinum `#e2e8f0` / `#94a3b8`, Rich Gold `#d97706`. These are exposed as tokens (`primary`, `gold`, `gold-ink`, `gold-soft`, `platinum`, `emerald-royal`, `emerald-deep`, `header*`) plus the severity tokens `critical`, `warning`, `info` and `ok`.
* **Modes.** Light is "Platinum"; dark is "Emerald Night". `next-themes` sets the `.dark` class, and the colour change is a 0.3 s transition (turned off under `prefers-reduced-motion`).
* **Surfaces.** `.glass` cards are translucent with a 14 px backdrop blur, a hairline inset and soft elevation. Text always sits on a layer that is at least 80 % opaque, so contrast stays at WCAG AA. `.gold-edge` draws a gold bar at the reading start of a widget.
* **Typography.** All fonts are self-hosted through `@fontsource`. Headings and figures use Cairo (`font-display`). Arabic body text uses IBM Plex Sans Arabic and Latin body text uses Inter. Amharic, Bengali and Hindi fall back to the locale's system stack.
* **RTL.** Only logical utilities are used, so the whole layout mirrors. Saudi number plates (`SaudiPlate`) always lay out LTR, like the physical plate.

**Layout (`/[locale]`):**
* **Header (`ExecShell`).**
  * The brand monogram.
  * The **tenant switcher**: a `<details>` menu that posts to `/api/tenant` and works without JS. Each household has a distinct badge (EFA emerald, AFA gold).
  * A live / sample pill.
  * The language and theme controls.
  * The module navigation.
* **Executive Daily Pulse.** Workforce by status with medical-checkup coverage, today's decisions from `GET /v1/dashboard/pulse`, and the ESB liability from `GET /v1/hr/end-of-service`.
* **Fleet status.** One card per vehicle with its plate, odometer, the nearest document expiry (Istimara, insurance, Fahas) and maintenance state.
* **Compliance highlights.**
* **Financial & Settlement Hub (`SettlementHub`).** You pick a worker and an as-of date. It shows:
  * **Art. 16** vested ESB and progress toward the next four-year vesting.
  * **Art. 10** unused-leave payout and progress through the current two-year cycle.
  * A live wage breakdown: wage, daily rate (÷30), monthly provision (÷48), total due, advances and the net amount.
* **Staff roster** with data-protection cues.

**Live binding:**
* **API client.** `src/lib/api.ts` is server-only, so the token never reaches the browser. It calls `HERP_API_URL` (default `http://localhost:4000`) with the bearer token from the httpOnly `herp_session` cookie.
* **Dev token.** `HERP_DEV_TOKEN` is honoured only when `NODE_ENV !== 'production'`.
* **Active household.** It comes from the httpOnly `herp_household` cookie and is sent as `X-Household-Id`. The API's membership check is still the authority. If the cookie names a household the user does not belong to, the first membership is used.
* **Settlement proxy.** `GET /api/settlement?staffId&asOf&locale` calls `end-of-service`, `leave-balance` and `final-settlement` under the same session. The browser never computes amounts in live mode.
* **Sample mode.** Without a session the page renders a clearly labelled sample. Sample settlement figures use the API's formulas (`src/lib/settlement-sample.ts`).

**Data protection cues (`EncryptedField`):**
* Identity numbers and IBANs are shown as a gold lock chip with `•••• last4`. The API returns only last-4; the full values are AES-256-GCM ciphertext under the household key.
* The health record is shown as "Encrypted". The dashboard never calls `GET /v1/staff/:id/health`, because reading that endpoint decrypts the record.
* A missing value is shown as plain "Not on file", without a lock.

**Demo data:** see the README. In short, `scripts/demo-households.sql` names the two fixture households EFA Private Office and AFA Household. `scripts/demo-seed.mjs` then seeds staff, contracts, documents, checkups, the Yukon and Camry, and an advance, all through the live API, and prints a dev token.

**Screenshots** are in `docs/screenshots/`: `exec-{ar,en}-{light,dark}.png`, `exec-ar-phone.png`, `exec-en-switcher.png`, `exec-en-afa.png` and `onboarding-ar.png`. They were taken against the live API. No page scrolls horizontally at 390 px.

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
