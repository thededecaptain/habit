import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { captureServerException } from "../instrument.server";
import { parseRequestUrl } from "./request-url.server";
import { withTransientRetry } from "./transient-retry.server";
import {
  captureWelcomePlanHandle,
  fetchAppPricingSubscription,
  loadAppPricingGrant,
  planSelectionUrl,
  rememberAppPricingGrant,
  shouldUseHostedPlanPage,
} from "./app-pricing.server";
import {
  STANDARD_PLAN,
  STANDARD_PLAN_AMOUNT,
  STANDARD_PLAN_CURRENCY,
  STANDARD_PLAN_HANDLE,
  STANDARD_PLAN_TRIAL_DAYS,
  trialEndsAt,
} from "./billing-plan";
export {
  APP_HANDLE,
  STANDARD_PLAN,
  STANDARD_PLAN_AMOUNT,
  STANDARD_PLAN_TRIAL_DAYS,
  USAGE_BILLING_ENABLED,
  trialEndsAt,
} from "./billing-plan";
export {
  captureWelcomePlanHandle,
  clearAppPricingGrant,
  planSelectionUrl,
  shouldUseHostedPlanPage,
} from "./app-pricing.server";

export type PaidAccess = {
  source: "billing-api" | "app-pricing";
  status: string;
  inTrial: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  billingSubscriptionId: string | null;
};

type ShopBillingContext = {
  shop?: string;
  shopId?: string;
  partnerDevelopment: boolean;
};

// Shop id and dev-store flag don't change between page loads, so cache them
// per shop instead of querying Shopify on every navigation.
const SHOP_CONTEXT_TTL_MS = 60 * 60 * 1000;
const shopContextCache = new Map<
  string,
  { value: ShopBillingContext; expiresAt: number }
>();

export async function loadShopBillingContext(
  admin: AdminApiContext,
  shop?: string,
): Promise<ShopBillingContext> {
  const cached = shop ? shopContextCache.get(shop) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const json = await withTransientRetry(async () => {
    const response = await admin.graphql(`#graphql
      query ShopBillingContext {
        shop {
          id
          plan {
            partnerDevelopment
          }
        }
      }
    `);
    return response.json();
  });
  const context = {
    shop,
    shopId: json.data?.shop?.id,
    partnerDevelopment: Boolean(json.data?.shop?.plan?.partnerDevelopment),
  };
  if (shop && context.shopId) {
    shopContextCache.set(shop, {
      value: context,
      expiresAt: Date.now() + SHOP_CONTEXT_TTL_MS,
    });
  }
  return context;
}

export async function shouldUseTestCharges(admin: AdminApiContext) {
  if (process.env.SHOPIFY_BILLING_TEST === "true") return true;
  if (process.env.SHOPIFY_BILLING_TEST === "false") return false;
  const context = await loadShopBillingContext(admin);
  return context.partnerDevelopment;
}

function testChargesFromEnvOrContext(partnerDevelopment: boolean) {
  if (process.env.SHOPIFY_BILLING_TEST === "true") return true;
  if (process.env.SHOPIFY_BILLING_TEST === "false") return false;
  return partnerDevelopment;
}

function paidAccessFromSubscription(subscription: {
  id: string;
  status?: string;
  trialDays?: number | null;
  createdAt?: string | null;
  currentPeriodEnd?: string | null;
}): PaidAccess {
  const trialEnd =
    subscription.createdAt && subscription.trialDays
      ? trialEndsAt(subscription.createdAt, subscription.trialDays)
      : null;
  const inTrial = trialEnd ? Date.now() < trialEnd.getTime() : false;
  return {
    source: "billing-api",
    status: subscription.status ?? "ACTIVE",
    inTrial,
    trialEndsAt: trialEnd?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    billingSubscriptionId: subscription.id,
  };
}

export async function findPaidAccess(
  billing: Awaited<ReturnType<typeof authenticate.admin>>["billing"],
  shopContext: ShopBillingContext,
  admin?: AdminApiContext,
): Promise<PaidAccess | null> {
  // Include test charges. Dev stores can only create those; excluding them
  // sends an approved shop back to Choose your plan.
  const check = await withTransientRetry(() => billing.check({ isTest: true }));
  const subscription = check.appSubscriptions[0];
  if (check.hasActivePayment && subscription) {
    return paidAccessFromSubscription(subscription);
  }

  if (admin) {
    const fallback = await loadActiveBillingSubscription(admin);
    if (fallback) return paidAccessFromSubscription(fallback);
  }

  const grant = await loadAppPricingGrant(shopContext.shop);
  if (grant) return grant;

  // Optional Partner API — only when the token is on the server.
  const contract = await fetchAppPricingSubscription(shopContext.shopId);
  if (!contract) return null;

  if (shopContext.shop) {
    await rememberAppPricingGrant(
      shopContext.shop,
      contract.itemHandle ?? STANDARD_PLAN_HANDLE,
    );
  }

  const inTrial = contract.trialEndsAt
    ? Date.now() < new Date(contract.trialEndsAt).getTime()
    : false;

  return {
    source: "app-pricing",
    status: "ACTIVE",
    inTrial,
    trialEndsAt: contract.trialEndsAt,
    currentPeriodEnd: contract.currentPeriodEnd,
    billingSubscriptionId: null,
  };
}

async function loadActiveBillingSubscription(admin: AdminApiContext) {
  const json = await withTransientRetry(async () => {
    const response = await admin.graphql(`#graphql
      query CurrentAppSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            trialDays
            createdAt
            currentPeriodEnd
          }
        }
      }
    `);
    return response.json();
  });
  const subscriptions =
    json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  return (
    subscriptions.find(
      (item: { status?: string }) => item.status === "ACTIVE",
    ) ?? null
  );
}

// The layout loader and the page loader both need paid access on every
// navigation, and they run in parallel. Share one lookup per shop for a short
// window so a page load costs one round of billing calls, not two.
const PAID_ACCESS_TTL_MS = 60 * 1000;
const paidAccessCache = new Map<
  string,
  { value: Promise<PaidAccess | null>; expiresAt: number }
>();

export function getPaidAccess(
  billing: Awaited<ReturnType<typeof authenticate.admin>>["billing"],
  shopContext: ShopBillingContext,
  admin?: AdminApiContext,
): Promise<PaidAccess | null> {
  const shop = shopContext.shop;
  if (!shop) return findPaidAccess(billing, shopContext, admin);

  const cached = paidAccessCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = findPaidAccess(billing, shopContext, admin);
  paidAccessCache.set(shop, { value, expiresAt: Date.now() + PAID_ACCESS_TTL_MS });
  // Never cache a failure or a missing plan: the next load should ask again.
  value.then(
    (access) => {
      if (!access) clearPaidAccessCache(shop);
    },
    () => clearPaidAccessCache(shop),
  );
  return value;
}

export function clearPaidAccessCache(shop: string) {
  paidAccessCache.delete(shop);
}

export async function requireStandardPlan(request: Request) {
  const url = parseRequestUrl(request);
  if (url.pathname.startsWith("/app/billing")) {
    return authenticate.admin(request);
  }

  const { admin, billing, redirect, session, ...rest } =
    await authenticate.admin(request);
  await captureWelcomePlanHandle(request, session.shop);

  let shopContext: ShopBillingContext;
  let access: PaidAccess | null;
  try {
    shopContext = await loadShopBillingContext(admin, session.shop);
    access = await getPaidAccess(billing, shopContext, admin);
  } catch (error) {
    // Shopify stayed unreachable through the retries. Let this page load
    // rather than show a 500; the plan is checked again on the next request.
    captureServerException(error, { phase: "requireStandardPlan", shop: session.shop });
    return { admin, billing, redirect, session, ...rest, isTest: false, access: null };
  }
  const isTest = testChargesFromEnvOrContext(shopContext.partnerDevelopment);

  if (!access) {
    throw await redirectToSubscribe(redirect, session.shop, shopContext);
  }

  return { admin, billing, redirect, session, ...rest, isTest, access };
}

export async function redirectToSubscribe(
  redirect: Awaited<ReturnType<typeof authenticate.admin>>["redirect"],
  shop: string,
  shopContext: ShopBillingContext,
  target: "_self" | "_top" = "_self",
) {
  if (shouldUseHostedPlanPage()) {
    return redirect(planSelectionUrl(shop), { target: "_top" });
  }
  return redirect("/app/billing", { target });
}

export function storeHandleFromShop(shop: string) {
  return shop.replace(/\.myshopify\.com$/i, "");
}

/** Admin embeds the app at /apps/{apiKey}, not /apps/{handle}. */
export function embeddedAppUrl(request: Request, shop: string) {
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const store = storeHandleFromShop(shop);
  const host = parseRequestUrl(request).searchParams.get("host");
  if (host) {
    try {
      const decoded = atob(host);
      if (decoded.includes("shopify.com")) {
        return `https://${decoded}/apps/${apiKey}`;
      }
    } catch {
      // use the store-handle fallback
    }
  }
  return `https://admin.shopify.com/store/${store}/apps/${apiKey}`;
}

/** Charge confirm links still come back as *.myshopify.com/admin — that hits login. */
export function toAdminShopifyUrl(url: string, shop: string) {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.endsWith(".myshopify.com") &&
      parsed.pathname.startsWith("/admin/")
    ) {
      const handle = storeHandleFromShop(shop);
      return `https://admin.shopify.com/store/${handle}${parsed.pathname.replace(
        /^\/admin/,
        "",
      )}${parsed.search}`;
    }
  } catch {
    // keep the original URL
  }
  return url;
}

export async function requestStandardSubscription(
  request: Request,
): Promise<never> {
  const { admin, redirect, session } = await authenticate.admin(request);
  const shopContext = await loadShopBillingContext(admin, session.shop);
  const isTest = testChargesFromEnvOrContext(shopContext.partnerDevelopment);
  const returnUrl = embeddedAppUrl(request, session.shop);

  const response = await admin.graphql(
    `#graphql
      mutation AppSubscriptionCreate(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $trialDays: Int
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        name: STANDARD_PLAN,
        returnUrl,
        test: isTest,
        trialDays: STANDARD_PLAN_TRIAL_DAYS,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                interval: "EVERY_30_DAYS",
                price: {
                  amount: STANDARD_PLAN_AMOUNT,
                  currencyCode: STANDARD_PLAN_CURRENCY,
                },
              },
            },
          },
        ],
      },
    },
  );
  const json = await response.json();
  const payload = json.data?.appSubscriptionCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length || !payload?.confirmationUrl) {
    const message =
      errors.map((error: { message: string }) => error.message).join(" ") ||
      "Could not start the Standard trial.";
    throw new Response(message, { status: 400 });
  }

  throw redirect(toAdminShopifyUrl(payload.confirmationUrl, session.shop), {
    target: "_top",
  });
}
