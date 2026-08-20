import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  STANDARD_PLAN,
  STANDARD_PLAN_AMOUNT,
  STANDARD_PLAN_TRIAL_DAYS,
  shouldUseTestCharges,
} from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing } = await authenticate.admin(request);
  const isTest = await shouldUseTestCharges(admin);
  const check = await billing.check({
    plans: [STANDARD_PLAN],
    isTest,
  });

  const url = new URL(request.url);
  const cancelled = url.searchParams.get("cancelled") === "1";

  if (check.hasActivePayment && !cancelled) {
    throw redirect("/app");
  }

  return {
    cancelled,
    amount: STANDARD_PLAN_AMOUNT,
    trialDays: STANDARD_PLAN_TRIAL_DAYS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing } = await authenticate.admin(request);
  const isTest = await shouldUseTestCharges(admin);

  await billing.request({
    plan: STANDARD_PLAN,
    isTest,
  });

  return null;
};

export default function Billing() {
  const { cancelled, amount, trialDays } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";

  return (
    <s-page heading="Choose your plan">
      {cancelled ? (
        <s-banner heading="Subscription cancelled" tone="info" dismissible>
          Your Habit subscription is cancelled. Start a new trial whenever you
          are ready.
        </s-banner>
      ) : null}

      <s-section heading="Standard">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            ${amount} per month. Points, VIP tiers, and referrals included. Cancel
            in one click from Settings.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>Unlimited customers and orders</s-list-item>
            <s-list-item>Automatic refund clawback</s-list-item>
            <s-list-item>Referral fraud protection</s-list-item>
            <s-list-item>Theme app extension install</s-list-item>
            <s-list-item>One-click cancel in the app</s-list-item>
          </s-unordered-list>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-button
              variant="primary"
              loading={submitting}
              onClick={() => fetcher.submit({}, { method: "POST" })}
            >
              Start {trialDays}-day free trial
            </s-button>
          </s-stack>
          <s-paragraph color="subdued">
            {trialDays}-day free trial. You will not be charged until the trial
            ends. Cancel anytime from Settings.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
