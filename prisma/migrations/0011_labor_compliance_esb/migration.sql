-- AlterEnum
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'SALARY_PAYMENT';

-- AlterEnum
ALTER TYPE "public"."PayrollLineType" ADD VALUE 'UNPAID_LEAVE';

-- CreateTable
CREATE TABLE "public"."esb_accruals" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "rule" TEXT NOT NULL,
    "serviceDays" INTEGER NOT NULL,
    "monthlyWage" DECIMAL(18,2) NOT NULL,
    "vested" DECIMAL(18,2) NOT NULL,
    "provision" DECIMAL(18,2) NOT NULL,
    "delta" DECIMAL(18,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esb_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "esb_accruals_householdId_periodYear_periodMonth_idx" ON "public"."esb_accruals"("householdId", "periodYear", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "esb_accruals_staffId_periodYear_periodMonth_key" ON "public"."esb_accruals"("staffId", "periodYear", "periodMonth");

-- AddForeignKey
ALTER TABLE "public"."esb_accruals" ADD CONSTRAINT "esb_accruals_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."esb_accruals" ADD CONSTRAINT "esb_accruals_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

