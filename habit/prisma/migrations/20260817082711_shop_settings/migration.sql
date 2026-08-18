-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "pointsPerDollar" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "redemptionRate" DECIMAL(8,2) NOT NULL DEFAULT 100,
    "minRedeemablePoints" INTEGER NOT NULL DEFAULT 100,
    "maxRedemptionPercent" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "referrerBonusPoints" INTEGER NOT NULL DEFAULT 500,
    "refereeBonusPoints" INTEGER NOT NULL DEFAULT 250,
    "referralCodeExpiryDays" INTEGER NOT NULL DEFAULT 30,
    "maxActiveReferralCodesPerCustomer" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);
