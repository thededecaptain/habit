import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateWebhookSafe } from "../lib/webhook-auth.server";

/**
 * GDPR mandatory webhook: a customer has requested their data. We don't
 * automate the export delivery (out of scope for v1) but we log the request
 * so the merchant can be notified manually within the required window.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticateWebhookSafe(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);

  const customer = payload.customer as { id?: string | number } | undefined;
  const shopifyCustomerId = String(customer?.id ?? "");
  if (shopifyCustomerId) {
    const record = await db.customer.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      include: { pointTransactions: true, ownedReferralCodes: true },
    });
    console.log(
      `Data request for shop=${shop} customer=${shopifyCustomerId}: ${
        record ? "found ledger data" : "no ledger data on file"
      }`,
    );
  }

  return new Response();
};
