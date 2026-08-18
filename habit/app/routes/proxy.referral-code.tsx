import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createReferralCode, ReferralError } from "../lib/ledger.server";

/**
 * Storefront-facing endpoint: generates (or returns the existing) referral
 * code for the logged-in customer. Authenticated via app proxy signature.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) {
    return Response.json({ error: "Log in to get your referral code." }, { status: 401 });
  }

  const existing = await db.customer.findUnique({
    where: { shop_shopifyCustomerId: { shop: session.shop, shopifyCustomerId: customerId } },
  });
  if (existing) {
    const active = await db.referralCode.findFirst({
      where: { shop: session.shop, ownerId: existing.id, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      return Response.json({ code: active.code });
    }
  }

  try {
    const referralCode = await createReferralCode(session.shop, customerId);
    return Response.json({ code: referralCode.code });
  } catch (error) {
    if (error instanceof ReferralError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
};
