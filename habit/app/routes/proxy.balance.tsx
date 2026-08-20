import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { getLoyaltySnapshot, ratesPayload } from "../lib/loyalty.server";

const GUEST_CACHE = "public, max-age=300, stale-while-revalidate=600";
const MEMBER_CACHE = "private, max-age=45";

function jsonWithCache(data: unknown, cacheControl: string) {
  return Response.json(data, {
    headers: { "Cache-Control": cacheControl },
  });
}

/**
 * Storefront-facing endpoint for the points widget theme app extension.
 * Authenticated via Shopify's app proxy signature (no session token
 * available on the storefront) — see shopify.app.toml [app_proxy].
 *
 * Guests should not hit this: the product widget renders rates from the
 * shop metafield in Liquid. Logged-in members still fetch a snapshot here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonWithCache({ loggedIn: false }, "private, no-store");
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const settings = await getOrCreateShopSettings(session.shop);
  const rates = ratesPayload(settings);

  if (!customerId) {
    return jsonWithCache(rates, GUEST_CACHE);
  }

  return jsonWithCache(await getLoyaltySnapshot(session.shop, customerId), MEMBER_CACHE);
};
