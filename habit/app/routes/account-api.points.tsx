import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { createReferralCode, ReferralError } from "../lib/ledger.server";
import { getLoyaltySnapshot } from "../lib/loyalty.server";

function shopFromDest(dest: string) {
  try {
    return new URL(dest).hostname;
  } catch {
    return dest.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function customerIdFromToken(sub: string | undefined) {
  if (!sub) return null;
  return sub.replace(/^gid:\/\/shopify\/Customer\//, "") || null;
}

async function snapshot(shop: string, shopifyCustomerId: string) {
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"] | undefined;
  try {
    admin = (await unauthenticated.admin(shop)).admin;
  } catch {
    admin = undefined;
  }
  return getLoyaltySnapshot(shop, shopifyCustomerId, { admin, includeHistory: true });
}

/**
 * Session-token-authenticated endpoint for the account-rewards customer
 * account UI extension. The customer ID is taken from the JWT `sub` claim
 * (not a query param) so it can't be spoofed.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = shopFromDest(String(sessionToken.dest));
  const customerId = customerIdFromToken(sessionToken.sub);

  if (!customerId) {
    return cors(Response.json({ loggedIn: false }));
  }

  return cors(Response.json(await snapshot(shop, customerId)));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = shopFromDest(String(sessionToken.dest));
  const customerId = customerIdFromToken(sessionToken.sub);

  if (!customerId) {
    return cors(Response.json({ error: "Not signed in." }, { status: 401 }));
  }

  try {
    const data = await snapshot(shop, customerId);
    if (data.referralCode) {
      return cors(Response.json({ code: data.referralCode }));
    }
    const referralCode = await createReferralCode(shop, customerId);
    return cors(Response.json({ code: referralCode.code }));
  } catch (error) {
    if (error instanceof ReferralError) {
      return cors(Response.json({ error: error.message }, { status: 400 }));
    }
    throw error;
  }
};
