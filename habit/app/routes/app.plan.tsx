import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import {
  isBillingTest,
  MONTHLY_PLAN_AMOUNT,
  MONTHLY_PLAN_CURRENCY,
  MONTHLY_TRIAL_DAYS,
} from "../lib/billing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest: isBillingTest(),
  });

  return {
    hasActivePayment,
    planName: MONTHLY_PLAN,
    amount: MONTHLY_PLAN_AMOUNT,
    currency: MONTHLY_PLAN_CURRENCY,
    trialDays: MONTHLY_TRIAL_DAYS,
    subscriptionName: appSubscriptions[0]?.name ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") !== "subscribe") {
    return { ok: false };
  }

  await billing.request({
    plan: MONTHLY_PLAN,
    isTest: isBillingTest(),
    trialDays: MONTHLY_TRIAL_DAYS,
  });
  return { ok: true };
};

export default function Plan() {
  const { hasActivePayment, planName, amount, currency, trialDays, subscriptionName } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";

  return (
    <s-page heading={hasActivePayment ? "Your plan" : "Start Habit"}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-heading>
            {planName} — ${amount} {currency} / 30 days
          </s-heading>
          <s-paragraph>
            Flat monthly price. Points, VIP tiers, and referrals stay on the same plan — no
            order-count cliff and no extra fee to cancel.
          </s-paragraph>
          <s-paragraph color="subdued">
            {trialDays}-day free trial. After that, Shopify bills this store ${amount} every 30
            days. You can cancel anytime from Settings.
          </s-paragraph>
          {hasActivePayment ? (
            <s-stack direction="block" gap="small-200">
              <s-badge tone="success">{subscriptionName ?? "Active"}</s-badge>
              <s-button href="/app">Continue to Habit</s-button>
              <s-button href="/app/settings" variant="secondary">
                Manage billing
              </s-button>
            </s-stack>
          ) : (
            <s-stack direction="block" gap="small-200">
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="subscribe" />
                <s-button variant="primary" type="submit" disabled={submitting}>
                  {submitting ? "Redirecting…" : `Start ${trialDays}-day trial`}
                </s-button>
              </fetcher.Form>
              <s-link href="/app/settings">Privacy exports and billing</s-link>
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
