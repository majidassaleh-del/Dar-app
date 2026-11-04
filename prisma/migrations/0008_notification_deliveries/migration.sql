-- CreateEnum
CREATE TYPE "public"."NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "public"."notifications" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "body" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "error" TEXT,
ADD COLUMN     "locale" "public"."Locale" NOT NULL DEFAULT 'ar',
ADD COLUMN     "payload" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "reminderId" UUID,
ADD COLUMN     "status" "public"."NotificationStatus" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "notifications_status_createdAt_idx" ON "public"."notifications"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_reminderId_userId_channel_key" ON "public"."notifications"("reminderId", "userId", "channel");

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "public"."reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

