import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bootstrapShop,
  ensureRedemptionDiscount,
  loadRedemptionDiscountTitle,
  syncLoyaltySettingsMetafield,
} from "../../app/lib/discount.server";
import {
  captureWelcomePlanHandle,
  clearAppPricingGrant,
  fetchAppPricingSubscription,
  loadAppPricingGrant,
  planSelectionUrl,
  rememberAppPricingGrant,
  shouldUseHostedPlanPage,
} from "../../app/lib/app-pricing.server";
import {
  clearPaidAccessCache,
  embeddedAppUrl,
  findPaidAccess,
  getPaidAccess,
  loadShopBillingContext,
  redirectToSubscribe,
  requestStandardSubscription,
  requireStandardPlan,
  shouldUseTestCharges,
  storeHandleFromShop,
  toAdminShopifyUrl,
} from "../../app/lib/billing.server";
import { getOrCreateShopSettings } from "../../app/lib/ledger.server";
import { makeSettings, prisma } from "../helpers/db";
import { adminContext, createFakeAdmin, networkError, shopify, shopifyServerModule, TEST_SHOP as shop } from "../helpers/shopify";

/** A shop no earlier test touched: billing caches shop context for an hour. */
function freshShop(name: string) {
  const domain = `${name}.myshopify.com`;
  shopifyServerModule.authenticate.admin.mockImplementation(async () => ({
    ...adminContext(),
    session: { id: `offline_${domain}`, shop: domain },
  }));
  return domain;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearPaidAccessCache(shop);
});

function shopContext(admin = shopify.admin, partnerDevelopment = false) {
  admin.on("ShopBillingContext", () => ({
    data: { shop: { id: "gid://shopify/Shop/1", plan: { partnerDevelopment } } },
  }));
}

function activeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/AppSubscription/1",
    status: "ACTIVE",
    trialDays: 30,
    createdAt: new Date().toISOString(),
    currentPeriodEnd: "2026-12-01T00:00:00Z",
    ...overrides,
  };
}

describe("loyalty settings metafield and redemption discount", () => {
  test("syncLoyaltySettingsMetafield writes the rates the Function reads", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const admin = createFakeAdmin().on("ShopId", () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }));
    const settings = await getOrCreateShopSettings(shop);
    await syncLoyaltySettingsMetafield(admin as never, shop, settings);
    const metafield = (admin.callsTo("SetLoyaltySettings")[0]?.variables?.metafields as { value: string; ownerId: string }[])[0]!;
    expect(metafield.ownerId).toBe("gid://shopify/Shop/1");
    expect(JSON.parse(metafield.value)).toEqual({ pointsPerDollar: 1, redemptionRate: 100, maxRedemptionPercent: 50, minRedeemablePoints: 100 });
  });

  test("syncLoyaltySettingsMetafield stops if the shop id can't be read, and retries network blips", async () => {
    const admin = createFakeAdmin();
    const settings = await getOrCreateShopSettings(shop);
    await syncLoyaltySettingsMetafield(admin as never, shop, settings);
    expect(admin.callsTo("SetLoyaltySettings")).toHaveLength(0);

    vi.spyOn(console, "log").mockImplementation(() => {});
    let failures = 1;
    admin.on("ShopId", () => (failures-- > 0 ? networkError() : { data: { shop: { id: "gid://shopify/Shop/1" } } }));
    await syncLoyaltySettingsMetafield(admin as never, shop, settings);
    expect(admin.callsTo("ShopId")).toHaveLength(3);
    expect(admin.callsTo("SetLoyaltySettings")).toHaveLength(1);
  });

  test("ensureRedemptionDiscount creates the discount once and remembers it", async () => {
    await makeSettings();
    const admin = createFakeAdmin().on("CreateRedemptionDiscount", () => ({
      data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/9" }, userErrors: [] } },
    }));
    expect(await ensureRedemptionDiscount(admin as never, shop)).toBe("gid://shopify/DiscountAutomaticNode/9");
    expect(await ensureRedemptionDiscount(admin as never, shop)).toBe("gid://shopify/DiscountAutomaticNode/9");
    expect(admin.callsTo("CreateRedemptionDiscount")).toHaveLength(1);
    const input = admin.callsTo("CreateRedemptionDiscount")[0]?.variables?.discount as Record<string, unknown>;
    expect(input).toMatchObject({ title: "Loyalty points redemption", functionHandle: "points-redemption", discountClasses: ["ORDER"] });
  });

  test("ensureRedemptionDiscount returns null on user errors, a missing id, or a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await makeSettings();
    const admin = createFakeAdmin().on("CreateRedemptionDiscount", () => ({
      data: { discountAutomaticAppCreate: { userErrors: [{ field: ["functionHandle"], message: "Function not found" }] } },
    }));
    expect(await ensureRedemptionDiscount(admin as never, shop)).toBeNull();
    admin.on("CreateRedemptionDiscount", () => ({ data: { discountAutomaticAppCreate: { userErrors: [] } } }));
    expect(await ensureRedemptionDiscount(admin as never, shop)).toBeNull();
    admin.on("CreateRedemptionDiscount", () => new Error("down"));
    expect(await ensureRedemptionDiscount(admin as never, shop)).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });

  test("bootstrapShop creates settings, syncs the metafield, and creates the discount", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const admin = createFakeAdmin()
      .on("ShopId", () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }))
      .on("CreateRedemptionDiscount", () => ({
        data: { discountAutomaticAppCreate: { automaticAppDiscount: { discountId: "d1" }, userErrors: [] } },
      }));
    await bootstrapShop(admin as never, shop);
    expect((await prisma.shopSettings.findUniqueOrThrow({ where: { shop } })).discountAutomaticId).toBe("d1");
    expect(admin.callsTo("SetLoyaltySettings")).toHaveLength(1);
  });

  test("loadRedemptionDiscountTitle reads the live title, tolerating failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = createFakeAdmin().on("RedemptionDiscountTitle", () => ({ data: { discountNode: { discount: { title: "Points!" } } } }));
    expect(await loadRedemptionDiscountTitle(admin, null)).toBeNull();
    expect(await loadRedemptionDiscountTitle(admin, "d1")).toBe("Points!");
    admin.on("RedemptionDiscountTitle", () => ({ data: {} }));
    expect(await loadRedemptionDiscountTitle(admin, "d1")).toBeNull();
    admin.on("RedemptionDiscountTitle", () => new Error("down"));
    expect(await loadRedemptionDiscountTitle(admin, "d1")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("App Pricing", () => {
  test("plan page URL and hosted-plan switch", () => {
    expect(planSelectionUrl("cool-store.myshopify.com")).toBe(
      "https://admin.shopify.com/store/cool-store/charges/habit-loyalty/pricing_plans",
    );
    expect(shouldUseHostedPlanPage()).toBe(false);
    vi.stubEnv("SHOPIFY_APP_PRICING", "true");
    expect(shouldUseHostedPlanPage()).toBe(true);
  });

  test("grants are remembered once, only for the Standard plan, and can be cleared", async () => {
    expect(await rememberAppPricingGrant(shop, "enterprise")).toBeNull();
    expect(await rememberAppPricingGrant(shop, "  ")).toBeNull();
    const first = await rememberAppPricingGrant(shop, " STANDARD ");
    expect(first).toMatchObject({ source: "app-pricing", status: "ACTIVE", inTrial: true, planHandle: "standard" });
    const again = await rememberAppPricingGrant(shop, "standard");
    expect(again?.trialEndsAt).toBe(first?.trialEndsAt);
    expect(await loadAppPricingGrant(shop)).toMatchObject({ planHandle: "standard" });
    await clearAppPricingGrant(shop);
    expect(await loadAppPricingGrant(shop)).toBeNull();
    expect(await loadAppPricingGrant(undefined)).toBeNull();
  });

  test("captureWelcomePlanHandle records the plan from Shopify's welcome link", async () => {
    expect(await captureWelcomePlanHandle(new Request("https://habit.test/app"), shop)).toBeNull();
    const grant = await captureWelcomePlanHandle(new Request("https://habit.test/app?plan_handle=standard"), shop);
    expect(grant?.planHandle).toBe("standard");
  });

  test("fetchAppPricingSubscription only calls the Partner API when configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAppPricingSubscription("gid://shopify/Shop/1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", "123");
    vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", "token");
    expect(await fetchAppPricingSubscription(undefined)).toBeNull();

    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: { activeSubscription: { trialEndsAt: "2026-10-01", currentBillingCycle: { endTime: "2026-11-01" }, items: [{ handle: "standard" }] } },
      }),
    );
    expect(await fetchAppPricingSubscription("gid://shopify/Shop/1")).toEqual({
      trialEndsAt: "2026-10-01",
      currentPeriodEnd: "2026-11-01",
      itemHandle: "standard",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://partners.shopify.com/123/api/2026-07/graphql.json");
    expect(JSON.parse(String(init.body)).variables.appId).toBe("gid://shopify/App/412113207297");

    vi.stubEnv("SHOPIFY_APP_GID", "gid://shopify/App/7");
    fetchMock.mockResolvedValueOnce(Response.json({ data: { activeSubscription: {} } }));
    expect(await fetchAppPricingSubscription("s")).toEqual({ trialEndsAt: null, currentPeriodEnd: null, itemHandle: null });
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).variables.appId).toBe("gid://shopify/App/7");

    fetchMock.mockResolvedValueOnce(Response.json({ data: { activeSubscription: null } }));
    expect(await fetchAppPricingSubscription("s")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500 }));
    expect(await fetchAppPricingSubscription("s")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchAppPricingSubscription("s")).toBeNull();
  });
});

describe("billing", () => {
  test("loadShopBillingContext caches per shop and retries network blips", async () => {
    let failures = 1;
    shopify.admin.on("ShopBillingContext", () =>
      failures-- > 0 ? networkError() : { data: { shop: { id: "gid://shopify/Shop/1", plan: { partnerDevelopment: true } } } },
    );
    const context = await loadShopBillingContext(shopify.admin as never, "cache-me.myshopify.com");
    expect(context).toEqual({ shop: "cache-me.myshopify.com", shopId: "gid://shopify/Shop/1", partnerDevelopment: true });
    await loadShopBillingContext(shopify.admin as never, "cache-me.myshopify.com");
    expect(shopify.admin.callsTo("ShopBillingContext")).toHaveLength(2); // one failure + one success, then cached
  });

  test("loadShopBillingContext without a shop id doesn't cache", async () => {
    await loadShopBillingContext(shopify.admin as never, "no-id.myshopify.com");
    await loadShopBillingContext(shopify.admin as never, "no-id.myshopify.com");
    expect(shopify.admin.callsTo("ShopBillingContext")).toHaveLength(2);
    expect(await loadShopBillingContext(shopify.admin as never)).toEqual({ shop: undefined, shopId: undefined, partnerDevelopment: false });
  });

  test("shouldUseTestCharges follows the env override, else the dev-store flag", async () => {
    vi.stubEnv("SHOPIFY_BILLING_TEST", "true");
    expect(await shouldUseTestCharges(shopify.admin as never)).toBe(true);
    vi.stubEnv("SHOPIFY_BILLING_TEST", "false");
    expect(await shouldUseTestCharges(shopify.admin as never)).toBe(false);
    vi.stubEnv("SHOPIFY_BILLING_TEST", "");
    shopContext(shopify.admin, true);
    expect(await shouldUseTestCharges(shopify.admin as never)).toBe(true);
  });

  test("findPaidAccess: Billing API subscription, in trial", async () => {
    shopify.billing.check.mockResolvedValue({ hasActivePayment: true, appSubscriptions: [activeSubscription()] });
    const access = await findPaidAccess(shopify.billing as never, { shop, partnerDevelopment: false });
    expect(access).toMatchObject({ source: "billing-api", status: "ACTIVE", inTrial: true, billingSubscriptionId: "gid://shopify/AppSubscription/1" });
    expect(shopify.billing.check).toHaveBeenCalledWith({ isTest: true });
  });

  test("findPaidAccess: falls back to the active subscriptions query", async () => {
    shopify.admin.on("CurrentAppSubscriptions", () => ({
      data: { currentAppInstallation: { activeSubscriptions: [activeSubscription({ status: "PENDING" }), activeSubscription({ trialDays: 0, id: "s2", status: undefined })] } },
    }));
    shopify.admin.on("CurrentAppSubscriptions", () => ({
      data: { currentAppInstallation: { activeSubscriptions: [activeSubscription({ status: "PENDING" }), activeSubscription({ trialDays: 0, id: "s2" })] } },
    }));
    const access = await findPaidAccess(shopify.billing as never, { shop, partnerDevelopment: false }, shopify.admin as never);
    expect(access).toMatchObject({ billingSubscriptionId: "s2", inTrial: false, trialEndsAt: null });
  });

  test("findPaidAccess: App Pricing grant, then Partner API contract, else nothing", async () => {
    await rememberAppPricingGrant(shop, "standard");
    expect((await findPaidAccess(shopify.billing as never, { shop, partnerDevelopment: false }))?.source).toBe("app-pricing");
    await clearAppPricingGrant(shop);

    expect(await findPaidAccess(shopify.billing as never, { shop, shopId: "s", partnerDevelopment: false })).toBeNull();

    vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", "1");
    vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: { activeSubscription: { trialEndsAt: new Date(Date.now() + 86400000).toISOString(), currentBillingCycle: null, items: [{ handle: null }] } },
    })));
    const access = await findPaidAccess(shopify.billing as never, { shop, shopId: "s", partnerDevelopment: false });
    expect(access).toMatchObject({ source: "app-pricing", inTrial: true });
    expect(await loadAppPricingGrant(shop)).toMatchObject({ planHandle: "standard" });

    await clearAppPricingGrant(shop);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { activeSubscription: { trialEndsAt: null } } })));
    expect(await findPaidAccess(shopify.billing as never, { shopId: "s", partnerDevelopment: false })).toMatchObject({ inTrial: false });
  });

  test("getPaidAccess shares one lookup per shop and never caches a miss or failure", async () => {
    shopify.billing.check.mockResolvedValue({ hasActivePayment: true, appSubscriptions: [activeSubscription()] });
    const ctx = { shop, partnerDevelopment: false };
    await Promise.all([getPaidAccess(shopify.billing as never, ctx), getPaidAccess(shopify.billing as never, ctx)]);
    expect(shopify.billing.check).toHaveBeenCalledTimes(1);
    clearPaidAccessCache(shop);

    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    expect(await getPaidAccess(shopify.billing as never, ctx)).toBeNull();
    await getPaidAccess(shopify.billing as never, ctx);
    expect(shopify.billing.check).toHaveBeenCalledTimes(3);

    shopify.billing.check.mockRejectedValue(new Error("boom"));
    await expect(getPaidAccess(shopify.billing as never, ctx)).rejects.toThrow("boom");
    shopify.billing.check.mockResolvedValue({ hasActivePayment: true, appSubscriptions: [activeSubscription()] });
    expect(await getPaidAccess(shopify.billing as never, ctx)).not.toBeNull();

    // No shop means no cache key: always a fresh lookup.
    await getPaidAccess(shopify.billing as never, { partnerDevelopment: false });
    await getPaidAccess(shopify.billing as never, { partnerDevelopment: false });
    expect(shopify.billing.check).toHaveBeenCalledTimes(7);
  });

  test("requireStandardPlan lets paid shops through and sends others to billing", async () => {
    shopContext();
    shopify.billing.check.mockResolvedValue({ hasActivePayment: true, appSubscriptions: [activeSubscription()] });
    const ok = await requireStandardPlan(new Request("https://habit.test/app"));
    expect(ok).toMatchObject({ isTest: false, access: { source: "billing-api" } });

    clearPaidAccessCache(shop);
    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    const thrown = await requireStandardPlan(new Request("https://habit.test/app")).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/app/billing");
  });

  test("requireStandardPlan skips the check on the billing page itself", async () => {
    const result = await requireStandardPlan(new Request("https://habit.test/app/billing"));
    expect(result).toMatchObject({ session: { shop } });
    expect(shopify.billing.check).not.toHaveBeenCalled();
  });

  test("requireStandardPlan loads the page instead of a 500 when Shopify stays unreachable", async () => {
    freshShop("unreachable");
    shopify.admin.on("ShopBillingContext", () => networkError());
    const result = await requireStandardPlan(new Request("https://habit.test/app/settings"));
    expect(result).toMatchObject({ access: null, isTest: false });
    expect(shopify.admin.callsTo("ShopBillingContext")).toHaveLength(3);
  });

  test("redirectToSubscribe uses the hosted plan page when App Pricing is on", async () => {
    vi.stubEnv("SHOPIFY_APP_PRICING", "true");
    const response = await redirectToSubscribe(shopify.redirect as never, shop, { shop, partnerDevelopment: false });
    expect(response.headers.get("Location")).toContain("/charges/habit-loyalty/pricing_plans");
    expect(response.headers.get("X-Target")).toBe("_top");
  });

  test("URL helpers", () => {
    expect(storeHandleFromShop("cool.myshopify.com")).toBe("cool");
    const host = btoa("admin.shopify.com/store/cool");
    expect(embeddedAppUrl(new Request(`https://habit.test/app?host=${host}`), "cool.myshopify.com")).toBe(
      "https://admin.shopify.com/store/cool/apps/test-api-key",
    );
    expect(embeddedAppUrl(new Request("https://habit.test/app?host=%%%"), "cool.myshopify.com")).toBe(
      "https://admin.shopify.com/store/cool/apps/test-api-key",
    );
    expect(embeddedAppUrl(new Request(`https://habit.test/app?host=${btoa("evil.example.com")}`), "cool.myshopify.com")).toBe(
      "https://admin.shopify.com/store/cool/apps/test-api-key",
    );
    expect(toAdminShopifyUrl("https://cool.myshopify.com/admin/charges/1/confirm?x=1", "cool.myshopify.com")).toBe(
      "https://admin.shopify.com/store/cool/charges/1/confirm?x=1",
    );
    expect(toAdminShopifyUrl("https://elsewhere.com/x", "cool.myshopify.com")).toBe("https://elsewhere.com/x");
    expect(toAdminShopifyUrl("not a url", "cool.myshopify.com")).toBe("not a url");
  });

  test("embeddedAppUrl without an API key still builds a URL", () => {
    vi.stubEnv("SHOPIFY_API_KEY", "");
    expect(embeddedAppUrl(new Request("https://habit.test/app"), "cool.myshopify.com")).toBe("https://admin.shopify.com/store/cool/apps/");
  });

  test("requestStandardSubscription sends the merchant to Shopify's approval page", async () => {
    const devShop = freshShop("habit-test-dev");
    shopContext(shopify.admin, true);
    shopify.admin.on("AppSubscriptionCreate", () => ({
      data: { appSubscriptionCreate: { confirmationUrl: `https://${devShop}/admin/charges/1/confirm`, userErrors: [] } },
    }));
    const thrown = await requestStandardSubscription(new Request("https://habit.test/app/billing")).catch((e) => e);
    expect((thrown as Response).headers.get("Location")).toBe("https://admin.shopify.com/store/habit-test-dev/charges/1/confirm");
    const variables = shopify.admin.callsTo("AppSubscriptionCreate")[0]?.variables as Record<string, unknown>;
    expect(variables).toMatchObject({ name: "Standard", test: true, trialDays: 30 });
  });

  test("requestStandardSubscription answers 400 with Shopify's error", async () => {
    shopContext();
    shopify.admin.on("AppSubscriptionCreate", () => ({ data: { appSubscriptionCreate: { userErrors: [{ message: "Plan unavailable" }] } } }));
    const thrown = (await requestStandardSubscription(new Request("https://habit.test/app/billing")).catch((e) => e)) as Response;
    expect(thrown.status).toBe(400);
    expect(await thrown.text()).toBe("Plan unavailable");
    shopify.admin.on("AppSubscriptionCreate", () => ({ data: {} }));
    const generic = (await requestStandardSubscription(new Request("https://habit.test/app/billing")).catch((e) => e)) as Response;
    expect(await generic.text()).toBe("Could not start the Standard trial.");
  });

  test("admin context helper exposes the fake session", () => {
    expect(adminContext().session.shop).toBe(shop);
  });
});
