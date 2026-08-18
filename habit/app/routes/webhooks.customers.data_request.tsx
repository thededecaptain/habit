import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR mandatory webhook: a customer has requested their data. We don't
 * automate the export delivery (out of scope for v1) but we log the request
 * so the merchant can be notified manually within the required window.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);

  const shopifyCustomerId = String(payload.customer?.id ?? "");
  if (shopifyCustomerId) {
    const customer = await db.customer.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      include: { pointTransactions: true, ownedReferralCodes: true },
    });
    console.log(
      `Data request for shop=${shop} customer=${shopifyCustomerId}: ${
        customer ? "found ledger data" : "no ledger data on file"
      }`,
    );
  }

  return new Response();
};
