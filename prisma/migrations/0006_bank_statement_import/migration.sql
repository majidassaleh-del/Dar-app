-- CreateEnum
CREATE TYPE "public"."StatementFormat" AS ENUM ('CSV', 'OFX');

-- CreateEnum
CREATE TYPE "public"."StatementImportStatus" AS ENUM ('PARSED', 'APPLIED');

-- CreateEnum
CREATE TYPE "public"."StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'CREATED', 'IGNORED');

-- CreateTable
CREATE TABLE "public"."bank_statement_imports" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "format" "public"."StatementFormat" NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "openingBalance" DECIMAL(18,2),
    "closingBalance" DECIMAL(18,2),
    "status" "public"."StatementImportStatus" NOT NULL DEFAULT 'PARSED',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "importedById" UUID NOT NULL,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."bank_statement_lines" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "bookedOn" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "balance" DECIMAL(18,2),
    "fingerprint" TEXT NOT NULL,
    "status" "public"."StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "transactionId" UUID,
    "matchScore" INTEGER,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_imports_householdId_accountId_idx" ON "public"."bank_statement_imports"("householdId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_accountId_sha256_key" ON "public"."bank_statement_imports"("accountId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_transactionId_key" ON "public"."bank_statement_lines"("transactionId");

-- CreateIndex
CREATE INDEX "bank_statement_lines_importId_status_idx" ON "public"."bank_statement_lines"("importId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_accountId_fingerprint_key" ON "public"."bank_statement_lines"("accountId", "fingerprint");

-- AddForeignKey
ALTER TABLE "public"."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_importId_fkey" FOREIGN KEY ("importId") REFERENCES "public"."bank_statement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

