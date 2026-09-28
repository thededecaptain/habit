-- Optional "first order only" rule for referrals (off: a customer can be referred once).
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "referralFirstOrderOnly" BOOLEAN NOT NULL DEFAULT false;

-- Why a referral code was last refused on an order.
ALTER TABLE "ReferralCode" ADD COLUMN IF NOT EXISTS "lastRejectedAt" TIMESTAMP(3);
ALTER TABLE "ReferralCode" ADD COLUMN IF NOT EXISTS "lastRejectedReason" TEXT;
ALTER TABLE "ReferralCode" ADD COLUMN IF NOT EXISTS "lastRejectedOrderId" TEXT;
