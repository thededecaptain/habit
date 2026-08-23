import prisma from "../db.server";
import {
  APP_HANDLE,
  STANDARD_PLAN_HANDLE,
  STANDARD_PLAN_TRIAL_DAYS,
  trialEndsAt,
} from "./billing-plan";
import { getOrCreateShopSettings } from "./ledger.server";

const PARTNER_API_VERSION = "2026-07";

export type AppPricingSubscription = {
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  itemHandle: string | null;
};

function partnerApiConfigured() {
  return Boolean(
    process.env.SHOPIFY_PARTNER_ORG_ID &&
      process.env.SHOPIFY_PARTNER_API_TOKEN &&
      (process.env.SHOPIFY_APP_GID || process.env.SHOPIFY_API_KEY),
  );
}

function appGid() {
  if (process.env.SHOPIFY_APP_GID) return process.env.SHOPIFY_APP_GID;
  return "gid://shopify/App/412113207297";
}

export function planSelectionUrl(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;
}

export function shouldUseHostedPlanPage() {
  // Only after Shopify App Pricing is enabled. The hosted
  // /charges/{handle}/pricing_plans URL 404s before that and Shopify
  // dumps the merchant on Settings → Apps.
  return process.env.SHOPIFY_APP_PRICING === "true";
}

/**
 * App Pricing contracts after the switch. Returns null when Partner API
 * is not configured, the shop has no contract, or the request fails —
 * callers must still trust the Billing API check.
 *
 * @see https://shopify.dev/docs/api/partner/2026-07/active-subscription
 */
export async function fetchAppPricingSubscription(
  shopId: string | undefined,
): Promise<AppPricingSubscription | null> {
  if (!shopId || !partnerApiConfigured()) return null;

  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID!;
  const token = process.env.SHOPIFY_PARTNER_API_TOKEN!;

  try {
    const response = await fetch(
      `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: `#graphql
            query ActiveSubscription($appId: ID!, $shopId: ID!) {
              activeSubscription(appId: $appId, shopId: $shopId) {
                trialEndsAt
                currentBillingCycle {
                  endTime
                }
                items {
                  handle
                }
              }
            }
          `,
          variables: { appId: appGid(), shopId },
        }),
      },
    );

    if (!response.ok) return null;

    const json = (await response.json()) as {
      data?: {
        activeSubscription?: {
          trialEndsAt?: string | null;
          currentBillingCycle?: { endTime?: string | null } | null;
          items?: Array<{ handle?: string | null }>;
        } | null;
      };
    };

    const contract = json.data?.activeSubscription;
    if (!contract) return null;

    return {
      trialEndsAt: contract.trialEndsAt ?? null,
      currentPeriodEnd: contract.currentBillingCycle?.endTime ?? null,
      itemHandle: contract.items?.[0]?.handle ?? null,
    };
  } catch {
    return null;
  }
}

function normalizePlanHandle(handle: string | null | undefined) {
  const value = handle?.trim().toLowerCase();
  if (!value) return null;
  if (value !== STANDARD_PLAN_HANDLE.toLowerCase()) return null;
  return STANDARD_PLAN_HANDLE;
}

export async function rememberAppPricingGrant(
  shop: string,
  planHandle: string | null | undefined,
) {
  const handle = normalizePlanHandle(planHandle);
  if (!handle) return null;

  const settings = await getOrCreateShopSettings(shop);
  if (
    settings.appPricingPlanHandle === handle &&
    settings.appPricingGrantedAt
  ) {
    return paidAccessFromGrant(handle, settings.appPricingGrantedAt);
  }

  const grantedAt = new Date();
  await prisma.shopSettings.update({
    where: { shop: settings.shop },
    data: {
      appPricingPlanHandle: handle,
      appPricingGrantedAt: grantedAt,
    },
  });
  return paidAccessFromGrant(handle, grantedAt);
}

export async function clearAppPricingGrant(shop: string) {
  await prisma.shopSettings.updateMany({
    where: { shop },
    data: {
      appPricingPlanHandle: null,
      appPricingGrantedAt: null,
    },
  });
}

export async function loadAppPricingGrant(shop: string | undefined) {
  if (!shop) return null;
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!settings?.appPricingPlanHandle || !settings.appPricingGrantedAt) {
    return null;
  }
  return paidAccessFromGrant(
    settings.appPricingPlanHandle,
    settings.appPricingGrantedAt,
  );
}

function paidAccessFromGrant(planHandle: string, grantedAt: Date) {
  const trialEnd = trialEndsAt(grantedAt.toISOString(), STANDARD_PLAN_TRIAL_DAYS);
  return {
    source: "app-pricing" as const,
    status: "ACTIVE",
    inTrial: Date.now() < trialEnd.getTime(),
    trialEndsAt: trialEnd.toISOString(),
    currentPeriodEnd: null as string | null,
    billingSubscriptionId: null as string | null,
    planHandle,
  };
}

export async function captureWelcomePlanHandle(request: Request, shop: string) {
  const handle = new URL(request.url).searchParams.get("plan_handle");
  if (!handle) return null;
  return rememberAppPricingGrant(shop, handle);
}
