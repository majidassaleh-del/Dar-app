-- CreateEnum
CREATE TYPE "public"."OdometerSource" AS ENUM ('MANUAL', 'FUEL', 'TRIP', 'SERVICE');

-- AlterEnum
ALTER TYPE "public"."AttachmentEntity" ADD VALUE 'MAINTENANCE_PLAN';

-- AlterTable
ALTER TABLE "public"."fuel_logs" ADD COLUMN     "anomalies" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "driverId" UUID,
ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fuelType" "public"."FuelType",
ADD COLUMN     "kmPerL" DECIMAL(6,2),
ADD COLUMN     "kmSinceLast" INTEGER,
ADD COLUMN     "pettyCashLogId" UUID,
ADD COLUMN     "receiptId" UUID;

-- AlterTable
ALTER TABLE "public"."maintenance_records" ADD COLUMN     "planId" UUID;

-- AlterTable
ALTER TABLE "public"."vehicles" ADD COLUMN     "expectedKmPerL" DECIMAL(5,2),
ADD COLUMN     "inspectionCenter" TEXT,
ADD COLUMN     "insuranceProvider" TEXT,
ADD COLUMN     "lastInspectionAt" DATE,
ADD COLUMN     "registrationNumber" TEXT,
ADD COLUMN     "tankCapacityL" DECIMAL(6,1);

-- CreateTable
CREATE TABLE "public"."maintenance_plans" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "type" "public"."MaintenanceType" NOT NULL,
    "titleI18n" JSONB NOT NULL DEFAULT '{}',
    "intervalKm" INTEGER,
    "intervalDays" INTEGER,
    "lastDoneAt" DATE,
    "lastDoneKm" INTEGER,
    "nextDueDate" DATE,
    "nextDueKm" INTEGER,
    "kmAlertAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."odometer_readings" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "readingKm" INTEGER NOT NULL,
    "readAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "public"."OdometerSource" NOT NULL DEFAULT 'MANUAL',
    "recordedById" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odometer_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_plans_householdId_nextDueDate_idx" ON "public"."maintenance_plans"("householdId", "nextDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plans_vehicleId_type_key" ON "public"."maintenance_plans"("vehicleId", "type");

-- CreateIndex
CREATE INDEX "odometer_readings_vehicleId_readAt_idx" ON "public"."odometer_readings"("vehicleId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_logs_receiptId_key" ON "public"."fuel_logs"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_logs_pettyCashLogId_key" ON "public"."fuel_logs"("pettyCashLogId");

-- AddForeignKey
ALTER TABLE "public"."maintenance_records" ADD CONSTRAINT "maintenance_records_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."maintenance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "public"."memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "public"."receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."fuel_logs" ADD CONSTRAINT "fuel_logs_pettyCashLogId_fkey" FOREIGN KEY ("pettyCashLogId") REFERENCES "public"."petty_cash_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_plans" ADD CONSTRAINT "maintenance_plans_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."maintenance_plans" ADD CONSTRAINT "maintenance_plans_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."odometer_readings" ADD CONSTRAINT "odometer_readings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."odometer_readings" ADD CONSTRAINT "odometer_readings_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."odometer_readings" ADD CONSTRAINT "odometer_readings_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "public"."memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

