import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { redirect } from "react-router";

import { authenticate } from "../shopify.server";
import { STANDARD_PLAN } from "./billing-plan";

export { STANDARD_PLAN, STANDARD_PLAN_AMOUNT, STANDARD_PLAN_TRIAL_DAYS } from "./billing-plan";

export async function shouldUseTestCharges(admin: AdminApiContext) {
  if (process.env.SHOPIFY_BILLING_TEST === "true") return true;
  if (process.env.SHOPIFY_BILLING_TEST === "false") return false;

  const response = await admin.graphql(`#graphql
    query ShopBillingContext {
      shop {
        plan {
          partnerDevelopment
        }
      }
    }
  `);
  const json = await response.json();
  return Boolean(json.data?.shop?.plan?.partnerDevelopment);
}

export async function requireStandardPlan(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/app/billing")) {
    return authenticate.admin(request);
  }

  const { admin, billing, ...rest } = await authenticate.admin(request);
  const isTest = await shouldUseTestCharges(admin);

  await billing.require({
    plans: [STANDARD_PLAN],
    isTest,
    onFailure: async () => redirect("/app/billing"),
  });

  return { admin, billing, ...rest, isTest };
}

export function trialEndsAt(createdAt: string, trialDays: number) {
  const end = new Date(createdAt);
  end.setUTCDate(end.getUTCDate() + trialDays);
  return end;
}
