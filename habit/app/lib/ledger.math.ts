const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type VipTierLike = {
  name: string;
  minSpend: unknown;
  minOrders: number | null;
  earnMultiplier: unknown;
  sortOrder: number;
};

/**
 * Picks the highest-sorted VIP tier the customer's lifetime totals qualify
 * for. Tiers with a null threshold on a given axis are ignored on that axis.
 */
export function resolveVipTier<T extends VipTierLike>(
  tiers: T[],
  lifetimeSpend: number,
  lifetimeOrders: number,
): T | null {
  const qualifying = tiers.filter((tier) => {
    const spendOk = tier.minSpend == null || lifetimeSpend >= Number(tier.minSpend);
    const ordersOk = tier.minOrders == null || lifetimeOrders >= tier.minOrders;
    return spendOk && ordersOk;
  });
  if (qualifying.length === 0) return null;
  return qualifying.sort((a, b) => b.sortOrder - a.sortOrder)[0]!;
}

export function calculateEarnPoints(
  subtotalAmount: number,
  pointsPerDollar: number,
  multiplier: number,
) {
  if (subtotalAmount <= 0 || pointsPerDollar <= 0 || multiplier <= 0) return 0;
  return Math.floor(subtotalAmount * pointsPerDollar * multiplier);
}

export function calculateRefundReversalPoints(params: {
  earnedPoints: number;
  alreadyReversedPoints: number;
  refundedAmount: number;
  orderSubtotal: number;
}) {
  const { earnedPoints, alreadyReversedPoints, refundedAmount, orderSubtotal } = params;
  const remaining = Math.max(earnedPoints - alreadyReversedPoints, 0);
  if (remaining <= 0) return 0;

  const proportion = orderSubtotal > 0 ? Math.min(Math.max(refundedAmount, 0) / orderSubtotal, 1) : 1;
  const targetReversal = Math.floor(earnedPoints * proportion);
  return Math.min(Math.max(targetReversal - alreadyReversedPoints, 0), remaining);
}

export function clampRedemption(pointsRequested: number, balance: number) {
  if (pointsRequested <= 0) return 0;
  return Math.min(pointsRequested, Math.max(balance, 0));
}

export function generateReferralCode(
  length = 8,
  random: () => number = Math.random,
) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += REFERRAL_CODE_ALPHABET[Math.floor(random() * REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}

export const REFERRAL_CODE_CHARS = REFERRAL_CODE_ALPHABET;
