import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  awardPointsForOrder,
  finalizeRedemptionForOrder,
  redeemReferralCode,
} from "../lib/ledger.server";
import { log } from "../lib/logger.server";

/**
 * Awards ledger points when an order is paid. Also finalizes any point
 * redemption and referral code applied at checkout — these can come from
 * either of two sources depending on merchant plan:
 *  - `$app` cart metafields, set by the redeem-points checkout UI
 *    extension (Shopify Plus only), which Shopify copies onto the order
 *    as order metafields; or
 *  - `points_to_redeem` / `referral_code` cart attributes, set by the
 *    cart-page "Redeem points" theme app block via the classic Ajax Cart
 *    API (all plans), which land in the order's `note_attributes`.
 * The metafield wins when both are present, matching the Function's
 * priority (see extensions/points-redemption/src/run.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, payload, topic } = await authenticate.webhook(request);
  log("info", "webhook.received", { topic, shop });

  if (!session || !admin) {
    log("warn", "webhook.skipped_no_session", { topic, shop });
    return new Response();
  }

  const orderId = String(payload.id ?? "");
  const customer = payload.customer as { id?: number | string; email?: string } | null;
  const subtotal = Number(payload.current_subtotal_price ?? payload.subtotal_price ?? 0);

  if (!orderId || !customer?.id) {
    log("warn", "webhook.orders_paid.skipped", {
      shop,
      orderId: orderId || null,
      customerId: customer?.id ?? null,
    });
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

  let pointsRedeemed = Number(attributeValue("points_to_redeem") ?? 0);
  let referralCode: string | null = attributeValue("referral_code");
  log("info", "webhook.orders_paid.attributes", {
    shop,
    orderId,
    pointsRedeemed,
    referralCode,
  });

  try {
    const response = await admin.graphql(
      `#graphql
      query OrderLoyaltyMetafields($id: ID!) {
        order(id: $id) {
          pointsToRedeem: metafield(namespace: "$app", key: "points_to_redeem") { value }
          referralCode: metafield(namespace: "$app", key: "referral_code") { value }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${orderId}` } },
    );
    const json = await response.json();
    const metafieldPoints = Number(json?.data?.order?.pointsToRedeem?.value ?? 0);
    if (metafieldPoints > 0) pointsRedeemed = metafieldPoints;
    referralCode = json?.data?.order?.referralCode?.value ?? referralCode;
  } catch (error) {
    log("error", "webhook.orders_paid.metafields_failed", { shop, orderId, error });
  }

  if (pointsRedeemed > 0) {
    await finalizeRedemptionForOrder({
      shop,
      orderId,
      shopifyCustomerId: String(customer.id),
      points: pointsRedeemed,
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
    } catch {
      // Invalid/expired/self-referral codes are silently ignored — the
      // customer already sees an explanation client-side if it's rejected.
    }
  }

  return new Response();
};
