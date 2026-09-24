import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { searchShopifyCustomers } from "../lib/loyalty.server";
import { parseRequestUrl } from "../lib/request-url.server";

/** Customer picker data for the Referrals page (fetcher.load only, no UI). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const q = parseRequestUrl(request).searchParams.get("q") ?? "";
  try {
    return { customers: await searchShopifyCustomers(admin, q), error: null };
  } catch (error) {
    console.warn("Customer search failed", error);
    return { customers: [], error: "Couldn't search customers. Try again." };
  }
};
