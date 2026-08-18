import type { RunInput, FunctionRunResult } from "../generated/api";
import { DiscountApplicationStrategy } from "../generated/api";
import { computeDiscountAmount, parseLoyaltySettings, pointsToRedeem } from "./discount";

const EMPTY_DISCOUNT: FunctionRunResult = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
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
  const points = pointsToRedeem(
    Number(input.cart.pointsMetafield?.value ?? 0),
    Number(input.cart.pointsAttribute?.value ?? 0),
  );
  const settings = parseLoyaltySettings(input.shop.metafield?.value);
  if (!points || !settings) {
    return EMPTY_DISCOUNT;
  }

  const discountAmount = computeDiscountAmount({
    points,
    redemptionRate: settings.redemptionRate,
    maxRedemptionPercent: settings.maxRedemptionPercent,
    subtotal: Number(input.cart.cost.subtotalAmount.amount),
  });

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
