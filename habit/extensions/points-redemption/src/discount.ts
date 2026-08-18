export type LoyaltySettings = {
  redemptionRate: number;
  maxRedemptionPercent: number;
};

export function parseLoyaltySettings(raw: string | null | undefined): LoyaltySettings | null {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Partial<LoyaltySettings>;
    const redemptionRate = Number(parsed.redemptionRate);
    const maxRedemptionPercent = Number(parsed.maxRedemptionPercent);
    if (!redemptionRate || redemptionRate <= 0) return null;
    return {
      redemptionRate,
      maxRedemptionPercent: Number.isFinite(maxRedemptionPercent) ? maxRedemptionPercent : 0,
    };
  } catch {
    return null;
  }
}

export function pointsToRedeem(fromMetafield: number, fromAttribute: number) {
  if (fromMetafield > 0) return fromMetafield;
  if (fromAttribute > 0) return fromAttribute;
  return 0;
}

export function computeDiscountAmount(params: {
  points: number;
  redemptionRate: number;
  maxRedemptionPercent: number;
  subtotal: number;
}) {
  const { points, redemptionRate, maxRedemptionPercent, subtotal } = params;
  if (points <= 0 || redemptionRate <= 0 || subtotal <= 0) return 0;

  const requestedDiscount = points / redemptionRate;
  const maxDiscount = maxRedemptionPercent ? subtotal * (maxRedemptionPercent / 100) : requestedDiscount;
  return Math.min(requestedDiscount, maxDiscount, subtotal);
}
