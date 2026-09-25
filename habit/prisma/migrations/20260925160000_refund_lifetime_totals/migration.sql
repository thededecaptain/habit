-- Lets refunds take an order back out of a member's lifetime totals once.
ALTER TABLE "PointTransaction" ADD COLUMN IF NOT EXISTS "spendReversed" DECIMAL(12,2);
ALTER TABLE "PointTransaction" ADD COLUMN IF NOT EXISTS "orderCountReversed" BOOLEAN NOT NULL DEFAULT false;
