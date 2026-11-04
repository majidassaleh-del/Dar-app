-- CreateEnum
CREATE TYPE "public"."DocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."AcknowledgmentFrequency" AS ENUM ('ONCE', 'ON_EACH_VERSION', 'DAILY', 'SHIFT_START');

-- CreateEnum
CREATE TYPE "public"."AcknowledgmentMethod" AS ENUM ('TAP_TO_ACCEPT', 'TYPED_NAME', 'DRAWN_SIGNATURE', 'OTP_CONFIRMED', 'VERBAL_WITNESSED');

-- CreateEnum
CREATE TYPE "public"."AgreementType" AS ENUM ('NON_DISCLOSURE', 'SURVEILLANCE_CONSENT', 'DATA_PROCESSING_CONSENT', 'CHILD_PRIVACY', 'SOCIAL_MEDIA');

-- CreateEnum
CREATE TYPE "public"."LawfulBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST', 'VITAL_INTEREST');

-- CreateEnum
CREATE TYPE "public"."PettyCashLogType" AS ENUM ('TOP_UP', 'EXPENSE', 'RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "public"."PettyCashLogStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."WorkOrderStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'VERIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."WorkOrderCategory" AS ENUM ('CLEANING', 'COOKING', 'CHILDCARE', 'DRIVING', 'ERRAND', 'GARDENING', 'MAINTENANCE', 'EVENT_PREP', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."TranslationStatus" AS ENUM ('ORIGINAL_ONLY', 'PENDING', 'MACHINE_TRANSLATED', 'HUMAN_REVIEWED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."TravelTripStatus" AS ENUM ('PLANNING', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PassengerType" AS ENUM ('ADULT', 'CHILD', 'INFANT');

-- CreateEnum
CREATE TYPE "public"."VisaStatus" AS ENUM ('NOT_REQUIRED', 'REQUIRED', 'APPLIED', 'GRANTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "public"."BookingType" AS ENUM ('FLIGHT', 'HOTEL', 'CAR_RENTAL', 'TRAIN', 'TRANSFER', 'ACTIVITY', 'TRAVEL_INSURANCE', 'VISA', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."BookingStatus" AS ENUM ('HOLD', 'CONFIRMED', 'TICKETED', 'CHECKED_IN', 'CANCELLED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "public"."SystemRole" ADD VALUE 'EFA_OFFICE_ADMIN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'POLICY';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'WORK_ORDER';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'TRIP';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'PETTY_CASH';

-- AlterTable
ALTER TABLE "public"."staff_profiles" DROP COLUMN "borderNumber",
ADD COLUMN     "borderNumberCiphertext" TEXT;

-- AlterTable
ALTER TABLE "public"."identity_documents" DROP COLUMN "number",
ADD COLUMN     "numberBlindIndex" TEXT NOT NULL,
ADD COLUMN     "numberCiphertext" TEXT NOT NULL,
ADD COLUMN     "numberLast4" VARCHAR(4);

-- AlterTable
ALTER TABLE "public"."financial_accounts" ADD COLUMN     "ibanBlindIndex" TEXT,
ADD COLUMN     "ibanCiphertext" TEXT;

-- AlterTable
ALTER TABLE "public"."leases" DROP COLUMN "counterpartyIdNo",
ADD COLUMN     "counterpartyIdCiphertext" TEXT;

-- CreateTable
CREATE TABLE "public"."policies" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "staffTypes" "public"."StaffType"[],
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "bodyI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "translationMeta" JSONB NOT NULL DEFAULT '{}',
    "ackFrequency" "public"."AcknowledgmentFrequency" NOT NULL DEFAULT 'ON_EACH_VERSION',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "contentHash" TEXT,
    "createdById" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."codes_of_ethics" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "appliesToRoles" "public"."SystemRole"[] DEFAULT ARRAY['STAFF', 'DRIVER']::"public"."SystemRole"[],
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "bodyI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "translationMeta" JSONB NOT NULL DEFAULT '{}',
    "effectiveFrom" DATE NOT NULL,
    "contentHash" TEXT,
    "createdById" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codes_of_ethics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."privacy_agreements" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "type" "public"."AgreementType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "appliesToRoles" "public"."SystemRole"[] DEFAULT ARRAY['STAFF', 'DRIVER']::"public"."SystemRole"[],
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "bodyI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "translationMeta" JSONB NOT NULL DEFAULT '{}',
    "lawfulBasis" "public"."LawfulBasis" NOT NULL DEFAULT 'CONSENT',
    "purposesI18n" JSONB NOT NULL DEFAULT '{}',
    "dataCategories" TEXT[],
    "surveillanceScope" JSONB,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "withdrawable" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" DATE NOT NULL,
    "contentHash" TEXT,
    "createdById" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."policy_acknowledgments" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "policyId" UUID,
    "codeOfEthicsId" UUID,
    "privacyAgreementId" UUID,
    "documentVersion" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "locale" "public"."Locale" NOT NULL,
    "method" "public"."AcknowledgmentMethod" NOT NULL DEFAULT 'TAP_TO_ACCEPT',
    "typedName" TEXT,
    "signatureStorageKey" TEXT,
    "witnessId" UUID,
    "ackDate" DATE NOT NULL DEFAULT CURRENT_DATE,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceInfo" JSONB,
    "ip" INET,
    "withdrawnAt" TIMESTAMPTZ(6),
    "withdrawalReason" TEXT,

    CONSTRAINT "policy_acknowledgments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."petty_cash_accounts" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "financialAccountId" UUID,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "floatLimit" DECIMAL(18,2) NOT NULL,
    "currentBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lowBalanceAlert" DECIMAL(18,2),
    "receiptRequiredOver" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastReconciledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "petty_cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."petty_cash_logs" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" "public"."PettyCashLogType" NOT NULL,
    "status" "public"."PettyCashLogStatus" NOT NULL DEFAULT 'APPROVED',
    "amount" DECIMAL(18,2) NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "categoryId" UUID,
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "merchantName" TEXT,
    "receiptId" UUID,
    "transactionId" UUID,
    "vehicleId" UUID,
    "workOrderId" UUID,
    "tripId" UUID,
    "recordedById" UUID NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geo" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "petty_cash_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_orders" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "category" "public"."WorkOrderCategory" NOT NULL DEFAULT 'OTHER',
    "priority" "public"."RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "public"."WorkOrderStatus" NOT NULL DEFAULT 'NEW',
    "requesterId" UUID NOT NULL,
    "assigneeId" UUID,
    "assigneeStaffType" "public"."StaffType",
    "vendorName" TEXT,
    "propertyId" UUID,
    "unitId" UUID,
    "vehicleId" UUID,
    "maintenanceTicketId" UUID,
    "requestId" UUID,
    "tripId" UUID,
    "scheduledAt" TIMESTAMPTZ(6),
    "dueAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "verifiedAt" TIMESTAMPTZ(6),
    "verifiedById" UUID,
    "recurrence" "public"."RecurrenceFrequency",
    "requiresPhotoProof" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCost" DECIMAL(18,2),
    "actualCost" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "rating" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_order_instructions" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "textI18n" JSONB NOT NULL DEFAULT '{}',
    "originalLocale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "translationStatus" "public"."TranslationStatus" NOT NULL DEFAULT 'PENDING',
    "translationMeta" JSONB NOT NULL DEFAULT '{}',
    "isSafetyCritical" BOOLEAN NOT NULL DEFAULT false,
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMPTZ(6),
    "completedById" UUID,
    "photoStorageKey" TEXT,
    "note" TEXT,

    CONSTRAINT "work_order_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."trips" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "organizerId" UUID NOT NULL,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "purpose" TEXT,
    "status" "public"."TravelTripStatus" NOT NULL DEFAULT 'PLANNING',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "destinations" JSONB NOT NULL DEFAULT '[]',
    "budget" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."trip_passengers" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "membershipId" UUID,
    "staffId" UUID,
    "guestNameI18n" JSONB,
    "passengerType" "public"."PassengerType" NOT NULL DEFAULT 'ADULT',
    "passportDocumentId" UUID,
    "visaStatus" "public"."VisaStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "exitReentryRequired" BOOLEAN NOT NULL DEFAULT false,
    "specialNeeds" TEXT,
    "seatPreference" TEXT,

    CONSTRAINT "trip_passengers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."trip_bookings" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "type" "public"."BookingType" NOT NULL,
    "status" "public"."BookingStatus" NOT NULL DEFAULT 'HOLD',
    "provider" TEXT,
    "confirmationRef" TEXT,
    "fromLocation" TEXT,
    "toLocation" TEXT,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6),
    "passengerIds" UUID[],
    "details" JSONB NOT NULL DEFAULT '{}',
    "amount" DECIMAL(18,2),
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "cancellationDeadline" TIMESTAMPTZ(6),
    "transactionId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trip_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tenant_keys" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kmsKeyName" TEXT NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "wrappedIndexKey" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policies_householdId_status_idx" ON "public"."policies"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "policies_householdId_code_version_key" ON "public"."policies"("householdId", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "codes_of_ethics_householdId_version_key" ON "public"."codes_of_ethics"("householdId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_agreements_householdId_type_version_key" ON "public"."privacy_agreements"("householdId", "type", "version");

-- CreateIndex
CREATE INDEX "policy_acknowledgments_householdId_membershipId_idx" ON "public"."policy_acknowledgments"("householdId", "membershipId");

-- CreateIndex
CREATE INDEX "policy_acknowledgments_privacyAgreementId_withdrawnAt_idx" ON "public"."policy_acknowledgments"("privacyAgreementId", "withdrawnAt");

-- CreateIndex
CREATE UNIQUE INDEX "policy_acknowledgments_membershipId_policyId_documentVersio_key" ON "public"."policy_acknowledgments"("membershipId", "policyId", "documentVersion", "ackDate");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_accounts_financialAccountId_key" ON "public"."petty_cash_accounts"("financialAccountId");

-- CreateIndex
CREATE INDEX "petty_cash_accounts_householdId_custodianId_idx" ON "public"."petty_cash_accounts"("householdId", "custodianId");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_logs_receiptId_key" ON "public"."petty_cash_logs"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "petty_cash_logs_transactionId_key" ON "public"."petty_cash_logs"("transactionId");

-- CreateIndex
CREATE INDEX "petty_cash_logs_accountId_occurredAt_idx" ON "public"."petty_cash_logs"("accountId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "petty_cash_logs_householdId_status_idx" ON "public"."petty_cash_logs"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_maintenanceTicketId_key" ON "public"."work_orders"("maintenanceTicketId");

-- CreateIndex
CREATE INDEX "work_orders_householdId_status_priority_idx" ON "public"."work_orders"("householdId", "status", "priority");

-- CreateIndex
CREATE INDEX "work_orders_assigneeId_status_idx" ON "public"."work_orders"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_householdId_number_key" ON "public"."work_orders"("householdId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "work_order_instructions_workOrderId_sequence_key" ON "public"."work_order_instructions"("workOrderId", "sequence");

-- CreateIndex
CREATE INDEX "trips_householdId_startDate_idx" ON "public"."trips"("householdId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "trip_passengers_tripId_membershipId_key" ON "public"."trip_passengers"("tripId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_passengers_tripId_staffId_key" ON "public"."trip_passengers"("tripId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_bookings_transactionId_key" ON "public"."trip_bookings"("transactionId");

-- CreateIndex
CREATE INDEX "trip_bookings_tripId_startAt_idx" ON "public"."trip_bookings"("tripId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_keys_householdId_version_key" ON "public"."tenant_keys"("householdId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "identity_documents_householdId_type_numberBlindIndex_key" ON "public"."identity_documents"("householdId", "type", "numberBlindIndex");

-- AddForeignKey
ALTER TABLE "public"."policies" ADD CONSTRAINT "policies_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."codes_of_ethics" ADD CONSTRAINT "codes_of_ethics_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."privacy_agreements" ADD CONSTRAINT "privacy_agreements_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_witnessId_fkey" FOREIGN KEY ("witnessId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "public"."policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_codeOfEthicsId_fkey" FOREIGN KEY ("codeOfEthicsId") REFERENCES "public"."codes_of_ethics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_privacyAgreementId_fkey" FOREIGN KEY ("privacyAgreementId") REFERENCES "public"."privacy_agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_accounts" ADD CONSTRAINT "petty_cash_accounts_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_accounts" ADD CONSTRAINT "petty_cash_accounts_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_accounts" ADD CONSTRAINT "petty_cash_accounts_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "public"."financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."petty_cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "public"."receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."petty_cash_logs" ADD CONSTRAINT "petty_cash_logs_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "public"."properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "public"."property_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_maintenanceTicketId_fkey" FOREIGN KEY ("maintenanceTicketId") REFERENCES "public"."maintenance_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "public"."requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_orders" ADD CONSTRAINT "work_orders_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_order_instructions" ADD CONSTRAINT "work_order_instructions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."work_order_instructions" ADD CONSTRAINT "work_order_instructions_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trips" ADD CONSTRAINT "trips_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trips" ADD CONSTRAINT "trips_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_passengers" ADD CONSTRAINT "trip_passengers_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_passengers" ADD CONSTRAINT "trip_passengers_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_passengers" ADD CONSTRAINT "trip_passengers_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_passengers" ADD CONSTRAINT "trip_passengers_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_passengers" ADD CONSTRAINT "trip_passengers_passportDocumentId_fkey" FOREIGN KEY ("passportDocumentId") REFERENCES "public"."identity_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_bookings" ADD CONSTRAINT "trip_bookings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_bookings" ADD CONSTRAINT "trip_bookings_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "public"."trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."trip_bookings" ADD CONSTRAINT "trip_bookings_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tenant_keys" ADD CONSTRAINT "tenant_keys_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
--  Hand-written constraints Prisma cannot express
-- =============================================================================

-- An acknowledgment points at exactly one document.
ALTER TABLE "policy_acknowledgments"
  ADD CONSTRAINT "ack_exactly_one_document"
  CHECK (num_nonnulls("policyId", "codeOfEthicsId", "privacyAgreementId") = 1);

-- One live (non-withdrawn) consent per signer per agreement; re-consent after withdrawal is a new row.
CREATE UNIQUE INDEX "ack_privacy_one_active"
  ON "policy_acknowledgments" ("membershipId", "privacyAgreementId")
  WHERE "privacyAgreementId" IS NOT NULL AND "withdrawnAt" IS NULL;
-- Ethics: once per version.
CREATE UNIQUE INDEX "ack_ethics_once_per_version"
  ON "policy_acknowledgments" ("membershipId", "codeOfEthicsId", "documentVersion")
  WHERE "codeOfEthicsId" IS NOT NULL;

ALTER TABLE "trip_passengers"
  ADD CONSTRAINT "passenger_identified"
  CHECK (num_nonnulls("membershipId", "staffId", "guestNameI18n") >= 1);

ALTER TABLE "trips" ADD CONSTRAINT "trip_dates" CHECK ("endDate" >= "startDate");

ALTER TABLE "petty_cash_logs"
  ADD CONSTRAINT "petty_cash_amount_sign"
  CHECK (("type" = 'ADJUSTMENT' AND "amount" <> 0) OR ("type" <> 'ADJUSTMENT' AND "amount" > 0));
ALTER TABLE "petty_cash_accounts" ADD CONSTRAINT "petty_cash_float_positive" CHECK ("floatLimit" > 0);

ALTER TABLE "work_orders" ADD CONSTRAINT "work_order_rating" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
