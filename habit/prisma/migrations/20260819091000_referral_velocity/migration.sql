-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "referralVelocityThreshold" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "ShopSettings" ADD COLUMN "referralVelocityWindowMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "ShopSettings" ADD COLUMN "referralVelocityAlertAt" TIMESTAMP(3);
ALTER TABLE "ShopSettings" ADD COLUMN "referralVelocityDismissedAt" TIMESTAMP(3);
