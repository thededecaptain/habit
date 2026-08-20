-- AlterEnum
ALTER TYPE "PointTransactionType" ADD VALUE 'EXPIRE';

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "pointsExpiryDays" INTEGER;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "lastActivityAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Customer_shop_lastActivityAt_idx" ON "Customer"("shop", "lastActivityAt");
