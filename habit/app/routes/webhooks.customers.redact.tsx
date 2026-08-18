import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR mandatory webhook: erase a customer's personal data 10 days after a
 * merchant deletes them (or on request). We keep anonymized point-ledger
 * rows (for the merchant's own accounting/fraud history) but scrub PII.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const shopifyCustomerId = String(payload.customer?.id ?? "");
  if (!shopifyCustomerId) return new Response();

  const customer = await db.customer.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
  });
  if (!customer) return new Response();

  await db.customer.update({
    where: { id: customer.id },
    data: { email: null },
  });

  return new Response();
};
