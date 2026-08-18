import type { LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { getLoyaltySnapshot, ratesPayload } from "../lib/loyalty.server";

/**
 * Storefront-facing endpoint for the points widget theme app extension.
 * Authenticated via Shopify's app proxy signature (no session token
 * available on the storefront) — see shopify.app.toml [app_proxy].
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ loggedIn: false }, { status: 200 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const settings = await getOrCreateShopSettings(session.shop);
  const rates = ratesPayload(settings);

  if (!customerId) {
    return Response.json(rates);
  }

  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"] | undefined;
  try {
    admin = (await unauthenticated.admin(session.shop)).admin;
  } catch {
    admin = undefined;
  }

  return Response.json(await getLoyaltySnapshot(session.shop, customerId, { admin }));
};
