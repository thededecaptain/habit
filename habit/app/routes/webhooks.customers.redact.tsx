import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateWebhookSafe } from "../lib/webhook-auth.server";

/**
 * GDPR mandatory webhook: erase a customer's personal data 10 days after a
 * merchant deletes them (or on request). We keep anonymized point-ledger
 * rows (for the merchant's own accounting/fraud history) but scrub PII.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticateWebhookSafe(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const customer = payload.customer as { id?: string | number } | undefined;
  const shopifyCustomerId = String(customer?.id ?? "");
  if (!shopifyCustomerId) return new Response();

  const record = await db.customer.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
  });
  if (!record) return new Response();

  await db.customer.update({
    where: { id: record.id },
    data: { email: null, displayName: null },
  });

  return new Response();
};
