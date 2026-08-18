import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { eraseShopData } from "../lib/privacy.server";

/**
 * GDPR mandatory webhook: 48 hours after a merchant uninstalls, Shopify asks
 * us to erase all of the shop's data, including sessions.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await eraseShopData(shop);
  return new Response();
};
