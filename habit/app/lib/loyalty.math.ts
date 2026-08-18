import type { VipTierLike } from "./ledger.math";

export function nextTierProgress(
  tiers: VipTierLike[],
  current: VipTierLike | null | undefined,
  lifetimeSpend: number,
  lifetimeOrders: number,
) {
  const next = [...tiers]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((tier) => !current || tier.sortOrder > current.sortOrder);

  if (!next) {
    return {
      nextTierName: null as string | null,
      nextTierRemainingSpend: null as number | null,
      nextTierRemainingOrders: null as number | null,
    };
  }

  const remainingSpend =
    next.minSpend != null ? Math.max(0, Number(next.minSpend) - lifetimeSpend) : null;
  const remainingOrders =
    next.minOrders != null ? Math.max(0, next.minOrders - lifetimeOrders) : null;

  return {
    nextTierName: next.name,
    nextTierRemainingSpend: remainingSpend,
    nextTierRemainingOrders: remainingOrders,
  };
}

export function ratesPayload(settings: {
  pointsPerDollar: unknown;
  redemptionRate: unknown;
  minRedeemablePoints: number;
  maxRedemptionPercent: unknown;
}) {
  return {
    loggedIn: false as const,
    pointsPerDollar: Number(settings.pointsPerDollar),
    redemptionRate: Number(settings.redemptionRate),
    minRedeemablePoints: settings.minRedeemablePoints,
    maxRedemptionPercent: Number(settings.maxRedemptionPercent),
  };
}
