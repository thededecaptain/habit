import type { RunInput, FunctionRunResult } from "../generated/api";
import { DiscountApplicationStrategy } from "../generated/api";

const EMPTY_DISCOUNT: FunctionRunResult = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
};

type LoyaltySettings = {
  redemptionRate: number;
  maxRedemptionPercent: number;
  minRedeemablePoints?: number;
};

/**
 * Redeems loyalty points for a fixed-amount order discount.
 *
 * The number of points to redeem comes from the `points_to_redeem` cart
 * attribute, written by both the cart widget (all plans) and the checkout
 * block (Plus); a `$app` cart metafield is still read for carts started
 * before the checkout block switched to attributes. This Function
 * re-derives the discount amount from shop-level settings (synced to a
 * shop metafield whenever a merchant saves their loyalty settings) and
 * independently caps it at `maxRedemptionPercent` of the order subtotal.
 *
 * The requested amount is shopper-editable (anyone can set a cart
 * attribute), so this is the enforcement point: the discount only applies
 * to a signed-in buyer, and never for more points than the balance the app
 * mirrors into their `$app:points_balance` customer metafield.
 */
export function run(input: RunInput): FunctionRunResult {
  const fromMetafield = Number(input.cart.pointsMetafield?.value ?? 0);
  const fromAttribute = Number(input.cart.pointsAttribute?.value ?? 0);
  // Both the cart widget and the checkout block now write the attribute; the
  // metafield is only read for carts started before that change.
  const requested = fromAttribute > 0 ? fromAttribute : fromMetafield;
  if (!Number.isFinite(requested) || requested <= 0) {
    return EMPTY_DISCOUNT;
  }

  const customer = input.cart.buyerIdentity?.customer;
  if (!customer) {
    return EMPTY_DISCOUNT;
  }
  const balance = Math.max(0, Math.floor(Number(customer.pointsBalance?.value ?? 0)) || 0);
  const pointsToRedeem = Math.min(Math.floor(requested), balance);

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
  const minRedeemablePoints = Number(settings.minRedeemablePoints ?? 0) || 0;
  if (pointsToRedeem <= 0 || pointsToRedeem < minRedeemablePoints) {
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
