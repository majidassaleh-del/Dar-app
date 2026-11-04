-- CreateEnum
CREATE TYPE "public"."AuthChallengeKind" AS ENUM ('PHONE_OTP', 'EMAIL_OTP', 'DEVICE_UNLOCK');

-- CreateTable
CREATE TABLE "public"."user_auth_factors" (
    "userId" UUID NOT NULL,
    "phone" TEXT,
    "phoneVerifiedAt" TIMESTAMPTZ(6),
    "email" CITEXT,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "totpSecretCiphertext" TEXT,
    "totpVerifiedAt" TIMESTAMPTZ(6),
    "totpLastStep" BIGINT,
    "totpFailures" INTEGER NOT NULL DEFAULT 0,
    "totpLockedUntil" TIMESTAMPTZ(6),
    "onboardedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_auth_factors_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "public"."auth_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "public"."AuthChallengeKind" NOT NULL,
    "target" TEXT,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."device_keys" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicKeyJwk" JSONB NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "device_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_challenges_userId_createdAt_idx" ON "public"."auth_challenges"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_keys_userId_deviceId_key" ON "public"."device_keys"("userId", "deviceId");

-- AddForeignKey
ALTER TABLE "public"."user_auth_factors" ADD CONSTRAINT "user_auth_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."auth_challenges" ADD CONSTRAINT "auth_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."device_keys" ADD CONSTRAINT "device_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

