import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { captureServerException } from "../instrument.server";
import { purgeShopData } from "../lib/shop-data.server";

/**
 * GDPR mandatory webhook: 48 hours after a merchant uninstalls, Shopify asks
 * us to erase all of the shop's data.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  const shopDomain =
    shop || String((payload as { shop_domain?: string }).shop_domain ?? "");
  console.log(`Received ${topic} webhook for ${shopDomain}`, payload);

  if (!shopDomain) {
    console.error("shop/redact missing shop domain", payload);
    return new Response();
  }

  try {
    await purgeShopData(shopDomain);
  } catch (error) {
    captureServerException(error, { webhook: "shop/redact" });
    throw error;
  }

  return new Response();
};
