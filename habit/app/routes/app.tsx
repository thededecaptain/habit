import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import { isBillingTest } from "../lib/billing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, redirect } = await authenticate.admin(request);
  const { hasActivePayment } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest: isBillingTest(),
  });

  const path = new URL(request.url).pathname;
  const allowUnpaid =
    path === "/app/plan" ||
    path.startsWith("/app/plan/") ||
    path === "/app/settings" ||
    path.startsWith("/app/privacy/");
  if (!hasActivePayment && !allowUnpaid) {
    throw redirect("/app/plan");
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    hasActivePayment,
  };
};

export default function App() {
  const { apiKey, hasActivePayment } = useLoaderData<typeof loader>();
  const location = useLocation();
  const onPlanPage = location.pathname === "/app/plan" || location.pathname.startsWith("/app/plan/");

  return (
    <AppProvider embedded apiKey={apiKey}>
      {onPlanPage ? null : (
        <s-app-nav>
          {hasActivePayment ? (
            <>
              <s-link href="/app">Home</s-link>
              <s-link href="/app/customers">Members</s-link>
              <s-link href="/app/tiers">VIP tiers</s-link>
              <s-link href="/app/settings">Settings</s-link>
            </>
          ) : (
            <>
              <s-link href="/app/plan">Plan</s-link>
              <s-link href="/app/settings">Settings</s-link>
            </>
          )}
        </s-app-nav>
      )}
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
