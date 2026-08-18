-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "redactedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "payload" JSONB NOT NULL,
    "exportData" JSONB,
    "status" TEXT NOT NULL DEFAULT 'received',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_idx" ON "PrivacyRequest"("shop");

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_shopifyCustomerId_idx" ON "PrivacyRequest"("shop", "shopifyCustomerId");

ALTER TABLE "PrivacyRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PrivacyRequest" FROM anon, authenticated;
