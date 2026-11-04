-- CreateEnum
CREATE TYPE "public"."SyncOpKind" AS ENUM ('TASK_UPDATE', 'INSTRUCTION_COMPLETE');

-- CreateEnum
CREATE TYPE "public"."SyncOpResult" AS ENUM ('APPLIED', 'CONFLICT', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."household_tasks" ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."work_order_instructions" ADD COLUMN     "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "public"."sync_operations" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "opId" UUID NOT NULL,
    "kind" "public"."SyncOpKind" NOT NULL,
    "entityId" UUID NOT NULL,
    "result" "public"."SyncOpResult" NOT NULL,
    "response" JSONB NOT NULL DEFAULT '{}',
    "clientAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_operations_householdId_receivedAt_idx" ON "public"."sync_operations"("householdId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_operations_membershipId_opId_key" ON "public"."sync_operations"("membershipId", "opId");

-- CreateIndex
CREATE INDEX "household_tasks_householdId_updatedAt_idx" ON "public"."household_tasks"("householdId", "updatedAt");

-- CreateIndex
CREATE INDEX "work_order_instructions_householdId_updatedAt_idx" ON "public"."work_order_instructions"("householdId", "updatedAt");

-- AddForeignKey
ALTER TABLE "public"."sync_operations" ADD CONSTRAINT "sync_operations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."sync_operations" ADD CONSTRAINT "sync_operations_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "public"."memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

