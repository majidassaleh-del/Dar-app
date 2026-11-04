-- CreateEnum
CREATE TYPE "public"."SalaryPaymentChannel" AS ENUM ('MUSANED', 'BANK_TRANSFER', 'CASH', 'DIGITAL_WALLET');

-- CreateEnum
CREATE TYPE "public"."SalaryPaymentStatus" AS ENUM ('RECORDED', 'ACKNOWLEDGED', 'DISPUTED', 'REVERSED');

-- AlterTable
ALTER TABLE "public"."staff_profiles" ADD COLUMN     "defaultPayoutChannel" "public"."SalaryPaymentChannel",
ADD COLUMN     "payoutIbanBlindIndex" TEXT,
ADD COLUMN     "payoutIbanCiphertext" TEXT,
ADD COLUMN     "payoutIbanLast4" VARCHAR(4),
ADD COLUMN     "payoutWalletRef" TEXT;

-- AlterTable
ALTER TABLE "public"."identity_documents" DROP COLUMN "remindDaysBefore",
ADD COLUMN     "alertDays" INTEGER[] DEFAULT ARRAY[60, 30, 15]::INTEGER[];

-- CreateTable
CREATE TABLE "public"."salary_payments" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "payrollRunId" UUID,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "channel" "public"."SalaryPaymentChannel" NOT NULL,
    "status" "public"."SalaryPaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "externalRef" TEXT,
    "payoutLast4" VARCHAR(4),
    "paidAt" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "proofFileId" UUID,
    "recordedById" UUID NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "ackMethod" "public"."AcknowledgmentMethod",
    "disputeReason" TEXT,
    "reversedAt" TIMESTAMPTZ(6),
    "reversalReason" TEXT,
    "transactionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salary_payments_transactionId_key" ON "public"."salary_payments"("transactionId");

-- CreateIndex
CREATE INDEX "salary_payments_staffId_periodYear_periodMonth_idx" ON "public"."salary_payments"("staffId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "salary_payments_householdId_status_idx" ON "public"."salary_payments"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_householdId_entityType_entityId_dueAt_remindAt_key" ON "public"."reminders"("householdId", "entityType", "entityId", "dueAt", "remindAt");

-- AddForeignKey
ALTER TABLE "public"."salary_payments" ADD CONSTRAINT "salary_payments_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_payments" ADD CONSTRAINT "salary_payments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_payments" ADD CONSTRAINT "salary_payments_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "public"."payroll_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."salary_payments" ADD CONSTRAINT "salary_payments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written constraints
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_period" CHECK ("periodMonth" BETWEEN 1 AND 12 AND "periodYear" BETWEEN 2000 AND 2100);
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_ref_required"
  CHECK ("channel" NOT IN ('MUSANED', 'BANK_TRANSFER') OR length(trim(coalesce("externalRef", ''))) > 0);
ALTER TABLE "identity_documents" ADD CONSTRAINT "alert_days_valid"
  CHECK (cardinality("alertDays") BETWEEN 1 AND 6 AND 0 < ALL ("alertDays") AND 366 > ALL ("alertDays"));
