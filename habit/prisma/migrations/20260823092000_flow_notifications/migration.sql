-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN IF EXISTS "klaviyoApiKeyEncrypted";
ALTER TABLE "ShopSettings" DROP COLUMN IF EXISTS "klaviyoEnabled";

-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN "shopifyCustomerId" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "orderId" TEXT;
