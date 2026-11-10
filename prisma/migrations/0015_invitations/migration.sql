-- Owner-issued, single-use, expiring invitations: the only way a new account is created.
-- CreateTable
CREATE TABLE "public"."invitations" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "email" CITEXT,
    "displayName" TEXT,
    "locale" "public"."Locale" NOT NULL DEFAULT 'ar',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "invitedById" UUID NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "acceptedUserId" UUID,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "public"."invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_householdId_createdAt_idx" ON "public"."invitations"("householdId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."invitations" ADD CONSTRAINT "invitations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "public"."households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."invitations" ADD CONSTRAINT "invitations_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
