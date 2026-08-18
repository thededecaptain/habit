import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { reverseForRefund } from "../lib/ledger.server";
import { log } from "../lib/logger.server";

/**
 * Automatic refund clawback: reverses the proportional share of points
 * earned on an order whenever it's refunded, so merchants never have to
 * manually claw back points (a documented Smile.io pain point).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, admin, payload, topic } = await authenticate.webhook(request);
  log("info", "webhook.received", { topic, shop });

  if (!session || !admin) return new Response();

  const orderId = String(payload.order_id ?? "");
  if (!orderId) return new Response();

  const transactions = (payload.transactions as Array<{
    kind?: string;
    status?: string;
    amount?: string;
  }> | undefined) ?? [];
  const refundedAmount = transactions
    .filter((t) => t.kind === "refund" && (t.status ?? "success") === "success")
    .reduce((sum, t) => sum + Number(t.amount ?? 0), 0);

  if (refundedAmount <= 0) return new Response();

  let orderSubtotal = 0;
  try {
    const response = await admin.graphql(
      `#graphql
      query OrderSubtotal($id: ID!) {
        order(id: $id) {
          subtotalPriceSet {
            shopMoney { amount }
          }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${orderId}` } },
    );
    const json = await response.json();
    orderSubtotal = Number(json?.data?.order?.subtotalPriceSet?.shopMoney?.amount ?? 0);
  } catch (error) {
    log("error", "webhook.refunds_create.subtotal_failed", { shop, orderId, error });
  }

  await reverseForRefund({ shop, orderId, refundedAmount, orderSubtotal });

  return new Response();
};
