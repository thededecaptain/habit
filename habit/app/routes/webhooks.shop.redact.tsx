import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR mandatory webhook: 48 hours after a merchant uninstalls, Shopify asks
 * us to erase all of the shop's data. Deletes every ledger record for the
 * shop (children first to satisfy foreign keys).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, payload);

  await db.pointTransaction.deleteMany({ where: { shop } });
  await db.referralCode.deleteMany({ where: { shop } });
  await db.customer.deleteMany({ where: { shop } });
  await db.vipTier.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });

  return new Response();
};
