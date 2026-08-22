import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { STANDARD_PLAN_HANDLE } from "../lib/billing-plan";
import {
  clearAppPricingGrant,
  rememberAppPricingGrant,
} from "../lib/app-pricing.server";

type SubscriptionPayload = {
  status?: string;
  plan_handle?: string;
  app_subscription?: {
    status?: string;
    plan_handle?: string;
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const body = payload as SubscriptionPayload;
  const status = (
    body.app_subscription?.status ??
    body.status ??
    ""
  ).toUpperCase();
  const handle =
    body.app_subscription?.plan_handle ??
    body.plan_handle ??
    STANDARD_PLAN_HANDLE;

  if (status === "ACTIVE" || status === "ACCEPTED") {
    await rememberAppPricingGrant(shop, handle);
  } else if (
    status === "CANCELLED" ||
    status === "DECLINED" ||
    status === "EXPIRED" ||
    status === "FROZEN"
  ) {
    await clearAppPricingGrant(shop);
  }

  return new Response();
};
