-- Tracks the balance last written to the customer's points_balance metafield.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "syncedPointsBalance" INTEGER;

-- Points spent on an order and returned when the order is refunded.
ALTER TYPE "PointTransactionType" ADD VALUE IF NOT EXISTS 'REDEMPTION_REFUND';
