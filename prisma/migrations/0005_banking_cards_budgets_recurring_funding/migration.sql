-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."JournalSource" ADD VALUE 'BANK_TRANSACTION';
ALTER TYPE "public"."JournalSource" ADD VALUE 'ACCOUNT_OPENING';

-- AlterTable
ALTER TABLE "public"."transactions" ADD COLUMN     "isFunding" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconciledAt" TIMESTAMPTZ(6),
ADD COLUMN     "recurringRuleId" UUID;

-- AlterTable
ALTER TABLE "public"."recurring_rules" ADD COLUMN     "createdById" UUID NOT NULL,
ADD COLUMN     "lastRunAt" TIMESTAMPTZ(6),
ADD COLUMN     "nameI18n" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "public"."funding_matches" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "journalEntryId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "matchedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funding_matches_householdId_journalEntryId_idx" ON "public"."funding_matches"("householdId", "journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "funding_matches_transactionId_journalEntryId_key" ON "public"."funding_matches"("transactionId", "journalEntryId");

-- AddForeignKey
ALTER TABLE "public"."transactions" ADD CONSTRAINT "transactions_recurringRuleId_fkey" FOREIGN KEY ("recurringRuleId") REFERENCES "public"."recurring_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."funding_matches" ADD CONSTRAINT "funding_matches_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."funding_matches" ADD CONSTRAINT "funding_matches_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."funding_matches" ADD CONSTRAINT "funding_matches_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints
ALTER TABLE "transactions" ADD CONSTRAINT "transaction_amount_positive" CHECK ("amount" > 0);
-- TRANSFER = between two own accounts, or an owner-funding outflow (no counter account).
ALTER TABLE "transactions" ADD CONSTRAINT "transaction_transfer_shape" CHECK (
  ("type" = 'TRANSFER') = ("counterAccountId" IS NOT NULL OR "isFunding")
  AND NOT ("isFunding" AND "counterAccountId" IS NOT NULL)
  AND ("counterAccountId" IS NULL OR "counterAccountId" <> "accountId"));
ALTER TABLE "funding_matches" ADD CONSTRAINT "funding_match_positive" CHECK ("amount" > 0);
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_interval" CHECK ("interval" BETWEEN 1 AND 24);
