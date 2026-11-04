-- CreateEnum
CREATE TYPE "public"."LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "public"."JournalSource" AS ENUM ('MANUAL', 'OPENING_BALANCE', 'REVERSAL', 'PETTY_CASH', 'PAYROLL', 'SALARY_PAYMENT', 'SALARY_ADVANCE');

-- CreateEnum
CREATE TYPE "public"."JournalStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterTable
ALTER TABLE "public"."households" ADD COLUMN     "booksClosedThrough" DATE;

-- CreateTable
CREATE TABLE "public"."ledger_accounts" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "type" "public"."LedgerAccountType" NOT NULL,
    "parentId" UUID,
    "isHeader" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "systemKey" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "categoryId" UUID,
    "financialAccountId" UUID,
    "pettyCashAccountId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."journal_entries" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "entryDate" DATE NOT NULL,
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "source" "public"."JournalSource" NOT NULL DEFAULT 'MANUAL',
    "sourceId" UUID,
    "status" "public"."JournalStatus" NOT NULL DEFAULT 'POSTED',
    "reversalOfId" UUID,
    "reversalReason" TEXT,
    "postedById" UUID,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."journal_lines" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "staffId" UUID,
    "memo" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_categoryId_key" ON "public"."ledger_accounts"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_financialAccountId_key" ON "public"."ledger_accounts"("financialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_pettyCashAccountId_key" ON "public"."ledger_accounts"("pettyCashAccountId");

-- CreateIndex
CREATE INDEX "ledger_accounts_householdId_type_idx" ON "public"."ledger_accounts"("householdId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_householdId_code_key" ON "public"."ledger_accounts"("householdId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_householdId_systemKey_key" ON "public"."ledger_accounts"("householdId", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversalOfId_key" ON "public"."journal_entries"("reversalOfId");

-- CreateIndex
CREATE INDEX "journal_entries_householdId_entryDate_idx" ON "public"."journal_entries"("householdId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_householdId_number_key" ON "public"."journal_entries"("householdId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_householdId_source_sourceId_key" ON "public"."journal_entries"("householdId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "journal_lines_entryId_idx" ON "public"."journal_lines"("entryId");

-- CreateIndex
CREATE INDEX "journal_lines_householdId_ledgerAccountId_idx" ON "public"."journal_lines"("householdId", "ledgerAccountId");

-- CreateIndex
CREATE INDEX "journal_lines_staffId_idx" ON "public"."journal_lines"("staffId");

-- AddForeignKey
ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "public"."financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_pettyCashAccountId_fkey" FOREIGN KEY ("pettyCashAccountId") REFERENCES "public"."petty_cash_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "journal_entries_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "journal_entries_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "public"."journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "public"."ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written constraints
-- A line is a debit XOR a credit, never negative, never zero.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_line_one_side"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));
-- Manual / opening entries carry no source id; hook entries always do.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_source_id"
  CHECK (("source" IN ('MANUAL', 'OPENING_BALANCE')) = ("sourceId" IS NULL) OR "source" = 'REVERSAL');
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_reversal_link"
  CHECK (("source" = 'REVERSAL') = ("reversalOfId" IS NOT NULL));
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_code_format" CHECK ("code" ~ '^[0-9]{4,10}$');
