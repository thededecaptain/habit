import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  awardPointsForOrder,
  finalizeRedemptionForOrder,
  getOrCreateShopSettings,
  redeemReferralCode,
  ReferralError,
} from "../lib/ledger.server";
import { syncPointsBalances } from "../lib/balance-sync.server";
import {
  loyaltyDiscountAmount,
  pointsForDiscount,
  type OrderDiscountPayload,
} from "../lib/order-discount.server";
import {
  loadRedemptionDiscountTitle,
  REDEMPTION_DISCOUNT_MESSAGE,
  REDEMPTION_DISCOUNT_TITLE,
} from "../lib/discount.server";

/**
 * Awards ledger points when an order is paid, then settles any points
 * redemption and referral code applied to the cart. Both the cart widget
 * (all plans) and the checkout block (Plus) save those as the
 * `points_to_redeem` / `referral_code` cart attributes, which land in the
 * order's `note_attributes`.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin) {
    console.warn(`Skipping ${topic} for ${shop}: missing session or admin client`);
    return new Response();
  }

  const orderId = String(payload.id ?? "");
  const customer = payload.customer as { id?: number | string; email?: string } | null;
  const subtotal = Number(payload.current_subtotal_price ?? payload.subtotal_price ?? 0);

  if (!orderId || !customer?.id) {
    console.warn(
      `Skipping ${topic} for ${shop}: orderId=${orderId || "(none)"} customer=${customer?.id ?? "(none)"}`,
    );
    return new Response();
  }

  await awardPointsForOrder({
    shop,
    orderId,
    shopifyCustomerId: String(customer.id),
    customerEmail: customer.email ?? null,
    subtotalAmount: subtotal,
  });

  const noteAttributes = (payload.note_attributes as { name?: string; key?: string; value?: string }[] | null) ?? [];
  const attributeValue = (name: string) =>
    noteAttributes.find((attr) => attr.name === name || attr.key === name)?.value ?? null;

  const pointsRedeemed = Number(attributeValue("points_to_redeem") ?? 0);
  const referralCode: string | null = attributeValue("referral_code");
  console.log(
    `Order ${orderId} loyalty attributes: points_to_redeem=${pointsRedeemed} referral=${referralCode ?? "(none)"} note_attributes=${JSON.stringify(noteAttributes)}`,
  );

  // Deduct what the order's loyalty discount was actually worth, whenever
  // one is on the order — not just when a points request reached us. The
  // Function caps the request at the balance and the max percent, the cart
  // may have shrunk since, and a request saved where the order can't see it
  // (an old cart metafield) must still be paid for.
  const points = await pointsSpentOnOrder({
    payload,
    requested: pointsRedeemed,
    shop,
    admin,
  });
  if (points > 0) {
    await finalizeRedemptionForOrder({
      shop,
      orderId,
      shopifyCustomerId: String(customer.id),
      points,
    });
  }

  if (referralCode) {
    try {
      await redeemReferralCode({
        shop,
        code: referralCode,
        refereeShopifyCustomerId: String(customer.id),
        orderId,
      });
    } catch (error) {
      // Invalid/expired/self-referral codes don't block the order — the
      // customer already sees an explanation client-side if it's rejected.
      if (!(error instanceof ReferralError)) throw error;
      console.warn(`Order ${orderId}: referral code ${referralCode} not applied — ${error.message}`);
    }
  }

  // Push the new balances (this customer, and a referrer) to the metafield
  // the checkout Function caps redemptions against. The cron retries misses.
  await syncPointsBalances(shop, { admin, limit: 50 });

  return new Response();
};

/**
 * Points the order's loyalty discount was worth. No loyalty discount on the
 * order means none was granted — e.g. a guest or a zero balance — so
 * nothing is deducted.
 */
async function pointsSpentOnOrder(params: {
  payload: Record<string, unknown>;
  requested: number;
  shop: string;
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
}) {
  const { requested, shop, admin } = params;
  const payload = params.payload as OrderDiscountPayload;
  // Most orders carry no automatic discount at all; skip the lookups.
  if (!(payload.discount_applications ?? []).some((a) => a.type === "automatic")) {
    if (requested > 0) console.warn(`Order discount check: ${requested} points requested but no loyalty discount on the order`);
    return 0;
  }

  const settings = await getOrCreateShopSettings(shop);
  const titles = [REDEMPTION_DISCOUNT_TITLE, REDEMPTION_DISCOUNT_MESSAGE];
  const liveTitle = await loadRedemptionDiscountTitle(admin, settings.discountAutomaticId);
  if (liveTitle) titles.push(liveTitle);

  const amount = loyaltyDiscountAmount(payload, titles);
  if (amount == null) {
    if (requested > 0) console.warn(`Order discount check: ${requested} points requested but no loyalty discount on the order`);
    return 0;
  }
  return pointsForDiscount(amount, Number(settings.redemptionRate), requested);
}
