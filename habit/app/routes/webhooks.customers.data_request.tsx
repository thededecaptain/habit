import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { fulfillCustomerDataRequest } from "../lib/privacy.server";

/**
 * GDPR mandatory webhook: a customer has requested their data. We assemble
 * the ledger export immediately so the merchant can download it from
 * Settings and send it to the customer within the required window.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const customer = payload.customer as { id?: string | number } | undefined;
  const shopifyCustomerId = String(customer?.id ?? "");
  await fulfillCustomerDataRequest({
    shop,
    shopifyCustomerId,
    payload: payload as Prisma.InputJsonValue,
  });
  return new Response();
};
