import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { getLoyaltySnapshot, ratesPayload } from "../lib/loyalty.server";

/**
 * Session-token-authenticated endpoint the redeem-points checkout UI
 * extension calls to find out how many points the buyer can redeem. The
 * extension only ever lets the buyer choose an amount within this response;
 * the points-redemption Shopify Function independently re-caps the discount
 * at checkout time as defense in depth (see extensions/points-redemption).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shop = new URL(sessionToken.dest).hostname;

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const settings = await getOrCreateShopSettings(shop);
  const shared = ratesPayload(settings);

  if (!customerId) {
    return cors(Response.json({ ...shared, pointsBalance: 0 }));
  }

  const numericId = customerId.replace(/^gid:\/\/shopify\/Customer\//, "");
  return cors(Response.json(await getLoyaltySnapshot(shop, numericId)));
};

/**
 * The extension sends an Authorization header, so the browser first issues a
 * CORS preflight. React Router routes OPTIONS to the action, and a route
 * without one answers 410 — which silently kills the real request. Calling
 * authenticate here answers the preflight with the required CORS headers.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.checkout(request);
  throw new Response(null, { status: 405, statusText: "Method Not Allowed" });
};
