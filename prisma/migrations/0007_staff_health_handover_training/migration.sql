-- CreateEnum
CREATE TYPE "public"."StaffAttachmentCategory" AS ENUM ('PASSPORT', 'IQAMA', 'DRIVING_LICENSE', 'ACADEMIC_CERTIFICATE', 'EMPLOYMENT_CONTRACT', 'MEDICAL_REPORT', 'SICK_LEAVE_CERTIFICATE', 'TRAINING_CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED');

-- CreateEnum
CREATE TYPE "public"."BloodType" AS ENUM ('A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'AB_POS', 'AB_NEG', 'O_POS', 'O_NEG', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "public"."MedicalResult" AS ENUM ('PENDING_RESULTS', 'FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT');

-- CreateEnum
CREATE TYPE "public"."HandoverItemType" AS ENUM ('VEHICLE_KEY', 'HOUSE_KEY', 'PHONE', 'PAYMENT_CARD', 'UNIFORM', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."HandoverStatus" AS ENUM ('PENDING_ACK', 'ISSUED', 'RETURNED', 'LOST');

-- CreateEnum
CREATE TYPE "public"."EvaluationStatus" AS ENUM ('DRAFT', 'SHARED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "public"."TrainingCategory" AS ENUM ('FIRST_AID', 'FIRE_SAFETY', 'CHILD_SAFETY', 'FOOD_HYGIENE', 'DEFENSIVE_DRIVING', 'HOUSEHOLD_POLICY', 'EQUIPMENT_SAFETY', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'STAFF';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'MEDICAL_CHECKUP';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'TRAINING';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'ASSET_HANDOVER';
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'EVALUATION';

-- AlterTable
ALTER TABLE "public"."attachments" ADD COLUMN     "category" "public"."StaffAttachmentCategory",
ADD COLUMN     "encrypted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sha256" CHAR(64),
ADD COLUMN     "staffId" UUID,
ADD COLUMN     "status" "public"."AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
ADD COLUMN     "uploadedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "public"."medical_checkups" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "checkupDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "result" "public"."MedicalResult" NOT NULL DEFAULT 'PENDING_RESULTS',
    "clinicName" TEXT,
    "restrictionsCiphertext" TEXT,
    "reportAttachmentId" UUID,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_checkups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."staff_health_profiles" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "bloodType" "public"."BloodType" NOT NULL DEFAULT 'UNKNOWN',
    "conditionsCiphertext" TEXT,
    "allergiesCiphertext" TEXT,
    "disclosedById" UUID,
    "disclosedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_health_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."asset_handovers" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "itemType" "public"."HandoverItemType" NOT NULL,
    "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
    "serialOrTag" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "vehicleId" UUID,
    "cardId" UUID,
    "conditionOut" TEXT,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" UUID NOT NULL,
    "expectedReturnAt" TIMESTAMPTZ(6),
    "status" "public"."HandoverStatus" NOT NULL DEFAULT 'PENDING_ACK',
    "ackAt" TIMESTAMPTZ(6),
    "ackMethod" "public"."AcknowledgmentMethod",
    "ackContentHash" TEXT,
    "returnedAt" TIMESTAMPTZ(6),
    "conditionIn" TEXT,
    "returnReceivedById" UUID,
    "lostNote" TEXT,

    CONSTRAINT "asset_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."staff_evaluations" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "evaluatorId" UUID NOT NULL,
    "scores" JSONB NOT NULL,
    "overall" DECIMAL(3,2) NOT NULL,
    "commentsI18n" JSONB NOT NULL DEFAULT '{}',
    "status" "public"."EvaluationStatus" NOT NULL DEFAULT 'DRAFT',
    "sharedAt" TIMESTAMPTZ(6),
    "acknowledgedAt" TIMESTAMPTZ(6),
    "workerComment" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."staff_trainings" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "category" "public"."TrainingCategory" NOT NULL,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "provider" TEXT,
    "completedAt" DATE NOT NULL,
    "validUntil" DATE,
    "hours" DECIMAL(5,1),
    "certificateAttachmentId" UUID,
    "recordedById" UUID NOT NULL,
    "workerAckAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_trainings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_checkups_staffId_validUntil_idx" ON "public"."medical_checkups"("staffId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "staff_health_profiles_staffId_key" ON "public"."staff_health_profiles"("staffId");

-- CreateIndex
CREATE INDEX "asset_handovers_staffId_status_idx" ON "public"."asset_handovers"("staffId", "status");

-- CreateIndex
CREATE INDEX "staff_evaluations_staffId_periodEnd_idx" ON "public"."staff_evaluations"("staffId", "periodEnd");

-- CreateIndex
CREATE INDEX "staff_trainings_staffId_validUntil_idx" ON "public"."staff_trainings"("staffId", "validUntil");

-- CreateIndex
CREATE INDEX "attachments_staffId_category_idx" ON "public"."attachments"("staffId", "category");

-- AddForeignKey
ALTER TABLE "public"."medical_checkups" ADD CONSTRAINT "medical_checkups_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."medical_checkups" ADD CONSTRAINT "medical_checkups_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_health_profiles" ADD CONSTRAINT "staff_health_profiles_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_health_profiles" ADD CONSTRAINT "staff_health_profiles_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."asset_handovers" ADD CONSTRAINT "asset_handovers_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."asset_handovers" ADD CONSTRAINT "asset_handovers_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_evaluations" ADD CONSTRAINT "staff_evaluations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_evaluations" ADD CONSTRAINT "staff_evaluations_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_trainings" ADD CONSTRAINT "staff_trainings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."staff_trainings" ADD CONSTRAINT "staff_trainings_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."attachments" ADD CONSTRAINT "attachments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written constraints
ALTER TABLE "medical_checkups" ADD CONSTRAINT "checkup_validity" CHECK ("validUntil" > "checkupDate" AND "validUntil" <= "checkupDate" + 400);
ALTER TABLE "asset_handovers" ADD CONSTRAINT "handover_quantity" CHECK ("quantity" BETWEEN 1 AND 1000);
ALTER TABLE "staff_evaluations" ADD CONSTRAINT "evaluation_period" CHECK ("periodEnd" >= "periodStart");
ALTER TABLE "staff_evaluations" ADD CONSTRAINT "evaluation_overall" CHECK ("overall" BETWEEN 1 AND 5);
