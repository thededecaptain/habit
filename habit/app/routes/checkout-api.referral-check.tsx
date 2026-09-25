import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  allowExtensionUserAgent,
  shopFromSessionTokenDest,
} from "../lib/extension-request.server";
import { checkReferralCode, ReferralError } from "../lib/ledger.server";
import { parseRequestUrl } from "../lib/request-url.server";

/**
 * Lets the checkout block check a referral code before saving it to the
 * cart, like the cart field does via the app proxy. The buyer (for the
 * self-referral and first-order checks) comes from the session token.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.checkout(
    allowExtensionUserAgent(request),
  );
  const shop = shopFromSessionTokenDest(sessionToken.dest);
  const customerId = sessionToken.sub?.replace(/^gid:\/\/shopify\/Customer\//, "") || null;

  try {
    const result = await checkReferralCode({
      shop,
      code: parseRequestUrl(request).searchParams.get("code") ?? "",
      refereeShopifyCustomerId: customerId,
    });
    return cors(Response.json({ valid: true, ...result }));
  } catch (error) {
    if (error instanceof ReferralError) {
      return cors(Response.json({ valid: false, error: error.message }));
    }
    throw error;
  }
};

// Answers the CORS preflight (see checkout-api.points.tsx).
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.checkout(allowExtensionUserAgent(request));
  throw new Response(null, { status: 405, statusText: "Method Not Allowed" });
};
