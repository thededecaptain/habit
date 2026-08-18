import type { RunInput, FunctionRunResult } from "../generated/api";
import { DiscountApplicationStrategy } from "../generated/api";

const EMPTY_DISCOUNT: FunctionRunResult = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
};

type LoyaltySettings = {
  redemptionRate: number;
  maxRedemptionPercent: number;
};

/**
 * Redeems loyalty points for a fixed-amount order discount.
 *
 * The number of points to redeem can come from two places, depending on
 * merchant plan and how the buyer applied it:
 *  - a `$app` cart metafield, set by the redeem-points checkout UI
 *    extension (Shopify Plus only), or
 *  - a `points_to_redeem` cart attribute, set by the cart-page "Redeem
 *    points" theme app block via the classic Ajax Cart API (all plans).
 * The metafield wins when both are present, since it reflects the buyer's
 * most recent edit right up to payment. Either way, this Function
 * re-derives the discount amount from shop-level settings (synced to a
 * shop metafield whenever a merchant saves their loyalty settings) and
 * independently caps it at `maxRedemptionPercent` of the order subtotal —
 * this is the enforcement point that can't be bypassed by tampering with
 * the cart attribute/metafield client-side.
 */
export function run(input: RunInput): FunctionRunResult {
  const fromMetafield = Number(input.cart.pointsMetafield?.value ?? 0);
  const fromAttribute = Number(input.cart.pointsAttribute?.value ?? 0);
  const pointsToRedeem = fromMetafield > 0 ? fromMetafield : fromAttribute;
  if (!pointsToRedeem || pointsToRedeem <= 0) {
    return EMPTY_DISCOUNT;
  }

  let settings: LoyaltySettings;
  try {
    settings = JSON.parse(input.shop.metafield?.value ?? "{}");
  } catch {
    return EMPTY_DISCOUNT;
  }

  const redemptionRate = Number(settings.redemptionRate);
  const maxRedemptionPercent = Number(settings.maxRedemptionPercent);
  if (!redemptionRate || redemptionRate <= 0) {
    return EMPTY_DISCOUNT;
  }

  const subtotal = Number(input.cart.cost.subtotalAmount.amount);
  const requestedDiscount = pointsToRedeem / redemptionRate;
  const maxDiscount = maxRedemptionPercent
    ? subtotal * (maxRedemptionPercent / 100)
    : requestedDiscount;
  const discountAmount = Math.min(requestedDiscount, maxDiscount, subtotal);

  if (discountAmount <= 0) {
    return EMPTY_DISCOUNT;
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.First,
    discounts: [
      {
        message: "Loyalty points redeemed",
        targets: [{ orderSubtotal: { excludedVariantIds: [] } }],
        value: {
          fixedAmount: {
            amount: discountAmount.toFixed(2),
          },
        },
      },
    ],
  };
}
