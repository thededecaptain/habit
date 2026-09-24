import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  allowExtensionUserAgent,
  shopFromSessionTokenDest,
} from "../lib/extension-request.server";
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
  const { sessionToken, cors } = await authenticate.public.checkout(
    allowExtensionUserAgent(request),
  );
  const shop = shopFromSessionTokenDest(sessionToken.dest);

  // The customer comes from the signed token's `sub` (present when the
  // buyer is logged in), never from the query string: any buyer at checkout
  // holds a valid token, so a customerId parameter would let them read
  // another customer's balance and referral code.
  const numericId = sessionToken.sub?.replace(/^gid:\/\/shopify\/Customer\//, "") || null;
  if (!numericId) {
    const settings = await getOrCreateShopSettings(shop);
    return cors(Response.json({ ...ratesPayload(settings), pointsBalance: 0 }));
  }

  return cors(Response.json(await getLoyaltySnapshot(shop, numericId)));
};

/**
 * The extension sends an Authorization header, so the browser first issues a
 * CORS preflight. React Router routes OPTIONS to the action, and a route
 * without one answers 410 — which silently kills the real request. Calling
 * authenticate here answers the preflight with the required CORS headers.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.checkout(allowExtensionUserAgent(request));
  throw new Response(null, { status: 405, statusText: "Method Not Allowed" });
};
