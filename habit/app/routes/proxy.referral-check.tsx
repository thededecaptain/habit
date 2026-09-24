import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { checkReferralCode, ReferralError } from "../lib/ledger.server";
import { parseRequestUrl } from "../lib/request-url.server";

/**
 * Storefront-facing endpoint: tells the cart's referral field whether a code
 * will be accepted before the shopper saves it to the cart. Authenticated via
 * app proxy signature. Works for guests; a logged-in shopper is also checked
 * for self-referral and a code already used.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ valid: false, error: "Not authenticated" }, { status: 401 });
  }

  const url = parseRequestUrl(request);
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const result = await checkReferralCode({
      shop: session.shop,
      code: url.searchParams.get("code") ?? "",
      refereeShopifyCustomerId: url.searchParams.get("logged_in_customer_id"),
    });
    return Response.json({ valid: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof ReferralError) {
      return Response.json({ valid: false, error: error.message }, { headers });
    }
    throw error;
  }
};
