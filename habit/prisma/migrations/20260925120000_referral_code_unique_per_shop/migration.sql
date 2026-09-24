-- Referral codes are unique per shop instead of globally.
DROP INDEX IF EXISTS "ReferralCode_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCode_shop_code_key" ON "ReferralCode"("shop", "code");
