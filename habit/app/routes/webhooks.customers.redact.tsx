import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { redactCustomerData } from "../lib/privacy.server";

/**
 * GDPR mandatory webhook: erase a customer's personal data 10 days after a
 * merchant deletes them (or on request). We keep anonymized point-ledger
 * rows (for the merchant's own accounting/fraud history) but scrub PII.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const customer = payload.customer as { id?: string | number } | undefined;
  const shopifyCustomerId = String(customer?.id ?? "");
  if (!shopifyCustomerId) return new Response();

  await redactCustomerData({
    shop,
    shopifyCustomerId,
    payload: payload as Prisma.InputJsonValue,
  });

  return new Response();
};
