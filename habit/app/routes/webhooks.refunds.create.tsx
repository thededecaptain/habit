import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { reverseForRefund } from "../lib/ledger.server";
import { syncPointsBalances } from "../lib/balance-sync.server";
import { withTransientRetry } from "../lib/transient-retry.server";

/**
 * Automatic refund handling: claws back the proportional share of points
 * an order earned, returns the points spent on it, and on a full refund
 * reverses the referral bonuses it triggered — so merchants never have to
 * fix balances by hand (a documented Smile.io pain point).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin) return new Response();

  const orderId = String(payload.order_id ?? "");
  if (!orderId) return new Response();

  // Measure refunds cumulatively, in subtotal terms like the points were
  // earned: the original subtotal minus the current one is everything
  // refunded (or edited off) so far, excluding tax and shipping. Comparing
  // cumulative targets with what was already reversed makes several partial
  // refunds add up, and a redelivered webhook a no-op. Without a subtotal
  // we'd have to guess, so if Shopify stays unreachable, fail and let
  // Shopify redeliver.
  const json = await withTransientRetry(async () => {
    const response = await admin.graphql(
      `#graphql
      query OrderSubtotals($id: ID!) {
        order(id: $id) {
          subtotalPriceSet { shopMoney { amount } }
          currentSubtotalPriceSet { shopMoney { amount } }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${orderId}` } },
    );
    return response.json();
  });
  const order = json?.data?.order;
  if (!order) return new Response();
  const orderSubtotal = Number(order.subtotalPriceSet?.shopMoney?.amount ?? 0);
  const currentSubtotal = Number(order.currentSubtotalPriceSet?.shopMoney?.amount ?? orderSubtotal);
  const refundedAmount = Math.max(0, orderSubtotal - currentSubtotal);
  // An amount-only refund (no items returned) leaves the subtotal unchanged:
  // the customer keeps the goods, so the points stand.
  if (refundedAmount <= 0) return new Response();

  await reverseForRefund({ shop, orderId, refundedAmount, orderSubtotal });
  await syncPointsBalances(shop, { admin, limit: 50 });

  return new Response();
};
