-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "klaviyoApiKeyEncrypted" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "klaviyoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSettings" ADD COLUMN "notificationWebhookUrl" TEXT;

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "uniqueKey" TEXT NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_shop_uniqueKey_key" ON "NotificationOutbox"("shop", "uniqueKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_availableAt_idx" ON "NotificationOutbox"("status", "availableAt");

-- The Shopify app only talks to Postgres through Prisma as the postgres role.
ALTER TABLE "NotificationOutbox" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "NotificationOutbox" FROM anon, authenticated;
