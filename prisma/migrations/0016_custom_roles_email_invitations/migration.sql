-- Custom roles: a household may have several roles built on the same base role
-- (e.g. "Head Driver" on DRIVER). One seeded default per base role is kept by a
-- partial unique index created in prisma/rls.sql.
-- DropIndex
DROP INDEX "public"."roles_householdId_systemRole_isDefault_key";

-- CreateIndex
CREATE INDEX "roles_householdId_systemRole_idx" ON "public"."roles"("householdId", "systemRole");

-- Invitations may be addressed to an e-mail alone.
-- AlterTable
ALTER TABLE "public"."invitations" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "public"."invitations" ADD CONSTRAINT "invitations_contact_required" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);
