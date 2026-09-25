import { beforeEach, describe, expect, test, vi } from "vitest";
import * as appLayout from "../../app/routes/app";
import * as dashboard from "../../app/routes/app._index";
import * as members from "../../app/routes/app.customers";
import * as memberDetail from "../../app/routes/app.customers.$id";
import * as tiers from "../../app/routes/app.tiers";
import * as settingsRoute from "../../app/routes/app.settings";
import * as referrals from "../../app/routes/app.referrals";
import * as billingRoute from "../../app/routes/app.billing";
import * as customerSearch from "../../app/routes/app.customer-search";
import { clearPaidAccessCache } from "../../app/lib/billing.server";
import { createReferralCode, getOrCreateShopSettings } from "../../app/lib/ledger.server";
import { rememberAppPricingGrant } from "../../app/lib/app-pricing.server";
import { makeCustomer, makeSettings, makeTier, member, prisma } from "../helpers/db";
import { networkError, shopify, TEST_SHOP as shop } from "../helpers/shopify";
import { call, get, post, quiet } from "../helpers/routes";

beforeEach(() => {
  quiet();
  clearPaidAccessCache(shop);
  shopify.admin.on("ShopBillingContext", () => ({ data: { shop: { id: "gid://shopify/Shop/1", plan: { partnerDevelopment: false } } } }));
  shopify.admin.on("ShopId", () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }));
  shopify.admin.on("SetPointsBalances", (variables) => ({
    data: { metafieldsSet: { metafields: (variables?.metafields as { ownerId: string }[]).map((m) => ({ owner: { id: m.ownerId } })), userErrors: [] } },
  }));
});

function paid() {
  shopify.billing.check.mockResolvedValue({
    hasActivePayment: true,
    appSubscriptions: [{ id: "sub1", status: "ACTIVE", trialDays: 30, createdAt: new Date().toISOString(), currentPeriodEnd: null }],
  });
}

describe("app layout", () => {
  test("requires the plan and passes the API key to App Bridge", async () => {
    paid();
    expect((await call(appLayout.loader, get("/app"))).value).toEqual({ apiKey: "test-api-key" });
    clearPaidAccessCache(shop);
    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    expect((await call(appLayout.loader, get("/app"))).thrown?.headers.get("Location")).toBe("/app/billing");
  });

  test("works without an API key configured", async () => {
    paid();
    vi.stubEnv("SHOPIFY_API_KEY", "");
    expect((await call(appLayout.loader, get("/app"))).value).toEqual({ apiKey: "" });
    vi.unstubAllEnvs();
  });
});

describe("dashboard", () => {
  test("reports members, points, liability and repeat rate, netting returned points", async () => {
    await makeSettings({ pointsPerDollar: 2, referralVelocityAlertAt: new Date() });
    await makeTier();
    const a = await makeCustomer({ pointsBalance: 300, lifetimeOrders: 2, lifetimeSpend: 500 });
    await makeCustomer({ pointsBalance: 100, lifetimeOrders: 1, lifetimeSpend: 100 });
    for (const [type, points] of [["EARN", 1000], ["REDEEM", -400], ["REDEMPTION_REFUND", 100]] as const) {
      await prisma.pointTransaction.create({ data: { shop, customerId: a.id, type, points } });
    }
    const { value } = await call(dashboard.loader, get("/app"));
    expect(value).toMatchObject({
      shop,
      onboardingDismissed: false,
      showVelocityAlert: true,
      hasCustomTiers: true,
      ratesReviewed: true,
      metrics: { memberCount: 2, pointsIssued: 1000, pointsRedeemed: 300, outstandingLiability: 400, repeatPurchaseRate: 0.5, redemptionOfGmv: 3 / 600 },
      completedSteps: [],
    });
  });

  test("a new shop shows zeros and an unreviewed setup", async () => {
    const { value } = await call(dashboard.loader, get("/app"));
    expect(value.metrics).toEqual({ memberCount: 0, pointsIssued: 0, pointsRedeemed: 0, outstandingLiability: 0, repeatPurchaseRate: 0, redemptionOfGmv: 0 });
    expect(value.ratesReviewed).toBe(false);
    expect(value.showVelocityAlert).toBe(false);
  });

  test("dismissals and manual setup steps persist", async () => {
    await getOrCreateShopSettings(shop);
    await call(dashboard.action, post("/app", { intent: "dismiss-onboarding" }));
    await call(dashboard.action, post("/app", { intent: "dismiss-velocity-alert" }));
    await call(dashboard.action, post("/app", { intent: "complete-step", step: "cart_embed" }));
    await call(dashboard.action, post("/app", { intent: "complete-step", step: "cart_embed" }));
    await call(dashboard.action, post("/app", { intent: "complete-step", step: "product_widget" }));
    await call(dashboard.action, post("/app", { intent: "complete-step", step: "not-a-step" }));
    await call(dashboard.action, post("/app", { intent: "uncomplete-step", step: "product_widget" }));
    await call(dashboard.action, post("/app", { intent: "something-else" }));
    const { value } = await call(dashboard.loader, get("/app"));
    expect(value.onboardingDismissed).toBe(true);
    expect(value.completedSteps).toEqual(["cart_embed"]);
  });

  test("tolerates corrupt stored setup steps", async () => {
    await makeSettings({ onboardingCompletedSteps: "not json" });
    expect((await call(dashboard.loader, get("/app"))).value.completedSteps).toEqual([]);
    await prisma.shopSettings.update({ where: { shop }, data: { onboardingCompletedSteps: JSON.stringify({ a: 1 }) } });
    expect((await call(dashboard.loader, get("/app"))).value.completedSteps).toEqual([]);
    await prisma.shopSettings.update({ where: { shop }, data: { onboardingCompletedSteps: JSON.stringify(["x", 3]) } });
    expect((await call(dashboard.loader, get("/app"))).value.completedSteps).toEqual(["x"]);
  });
});

describe("members", () => {
  test("lists and searches members, 50 per page", async () => {
    const tier = await makeTier({ name: "Gold" });
    await makeCustomer({ email: "ann@example.com", displayName: "Ann", vipTierId: tier.id });
    for (let i = 0; i < 51; i += 1) await makeCustomer({ email: `bulk${i}@example.com` });
    const first = await call(members.loader, get("/app/customers"));
    expect(first.value.customers).toHaveLength(50);
    expect(first.value.hasNext).toBe(true);
    const second = await call(members.loader, get("/app/customers?page=2"));
    expect(second.value.customers).toHaveLength(2);
    const search = await call(members.loader, get("/app/customers?q=ANN"));
    expect(search.value.customers).toEqual([expect.objectContaining({ displayName: "Ann", tierName: "Gold" })]);
    expect((await call(members.loader, get("/app/customers?page=abc"))).value.page).toBe(1);
  });

  test("manual adjustments are validated, recorded, and synced", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 10 });
    const adjust = (fields: Record<string, string>) => call(members.action, post("/app/customers", { customerId: a.id, ...fields }));
    expect((await adjust({ amount: "0", reason: "x" })).value.errors.amount).toBeTruthy();
    expect((await adjust({ amount: "1.5", reason: "x" })).value.errors.amount).toBeTruthy();
    expect((await adjust({ amount: "abc", reason: "x" })).value.errors.amount).toBeTruthy();
    expect((await adjust({ amount: "2000000", reason: "x" })).value.errors.amount).toContain("at most");
    expect((await adjust({ amount: "5", reason: " " })).value.errors.reason).toBeTruthy();
    expect((await call(members.action, post("/app/customers", { customerId: "nope", amount: "5", reason: "x" }))).value.errors.amount).toBe("Member not found.");
    expect((await adjust({ amount: "-4", reason: "Goodwill" })).value).toEqual({ ok: true });
    const updated = await member("1");
    expect(updated.pointsBalance).toBe(6);
    expect(updated.syncedPointsBalance).toBe(6);
    expect((await prisma.pointTransaction.findFirstOrThrow()).description).toBe("Goodwill");
  });
});

describe("member detail", () => {
  test("shows the profile, ledger and referral codes, syncing the profile first", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1", email: null, displayName: null });
    await createReferralCode(shop, "1", { code: "MYCODE", createdByMerchant: true, expiresInDays: null });
    await prisma.pointTransaction.create({ data: { shop, customerId: a.id, type: "EARN", points: 10, orderId: "o1" } });
    shopify.admin.on("HabitCustomers", () => ({
      data: { nodes: [{ id: "gid://shopify/Customer/1", firstName: "Ann", lastName: null, defaultEmailAddress: { emailAddress: "ann@example.com" }, amountSpent: { amount: "0" }, numberOfOrders: 0 }] },
    }));
    const { value } = await call(memberDetail.loader, get(`/app/customers/${a.id}`), { id: a.id });
    expect(value.customer).toMatchObject({ displayName: "Ann", email: "ann@example.com", tierName: null });
    expect(value.transactions).toHaveLength(1);
    expect(value.referralCodes).toEqual([expect.objectContaining({ code: "MYCODE", status: "ACTIVE", expiresAt: null })]);
  });

  test("a failed profile sync still shows the page; unknown members 404", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1" });
    shopify.admin.on("HabitCustomers", () => new Error("down"));
    expect((await call(memberDetail.loader, get(`/app/customers/${a.id}`), { id: a.id })).value.customer.id).toBe(a.id);
    expect((await call(memberDetail.loader, get("/app/customers/nope"), { id: "nope" })).thrown?.status).toBe(404);
  });

  test("404s if the member disappears mid-request", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1" });
    shopify.admin.on("HabitCustomers", async () => {
      await prisma.customer.delete({ where: { id: a.id } });
      return { data: { nodes: [] } };
    });
    expect((await call(memberDetail.loader, get(`/app/customers/${a.id}`), { id: a.id })).thrown?.status).toBe(404);
  });

  test("revoking a code only touches that member's active code", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1" });
    const code = await createReferralCode(shop, "1", { code: "MYCODE", createdByMerchant: true });
    expect((await call(memberDetail.action, post("/x", { intent: "revoke-code", codeId: code.id }), { id: a.id })).value).toEqual({ ok: true });
    expect((await prisma.referralCode.findUniqueOrThrow({ where: { id: code.id } })).status).toBe("REVOKED");
    expect((await call(memberDetail.action, post("/x", { intent: "other" }), { id: a.id })).value).toBeNull();
    await call(memberDetail.action, post("/x", {}), { id: a.id });
  });
});

describe("VIP tiers", () => {
  test("lists tiers in order and creates, updates, deletes them", async () => {
    expect((await call(tiers.action, post("/app/tiers", { name: "Gold", minSpend: "500", earnMultiplier: "1.5" }))).value).toEqual({ ok: true });
    await call(tiers.action, post("/app/tiers", { name: "Silver", minOrders: "2", earnMultiplier: "1.25", sortOrder: "" }));
    const listed = (await call(tiers.loader, get("/app/tiers"))).value.tiers;
    expect(listed.map((t: { name: string }) => t.name)).toEqual(["Gold", "Silver"]);
    expect(listed[0]).toMatchObject({ minSpend: 500, minOrders: null, earnMultiplier: 1.5 });
    expect(listed[1]).toMatchObject({ minSpend: null, minOrders: 2 });

    const gold = listed[0];
    await call(tiers.action, post("/app/tiers", { intent: "update", id: gold.id, name: "Gold", minSpend: "600", earnMultiplier: "2", sortOrder: "3" }));
    expect((await prisma.vipTier.findUniqueOrThrow({ where: { id: gold.id } })).sortOrder).toBe(3);
    await call(tiers.action, post("/app/tiers", { intent: "delete", id: gold.id }));
    expect(await prisma.vipTier.count()).toBe(1);
  });

  test("rejects bad input with field errors instead of failing", async () => {
    await makeTier({ name: "Gold", minSpend: 100 });
    const errorsFor = async (fields: Record<string, string>) =>
      (await call(tiers.action, post("/app/tiers", { name: "T", minSpend: "10", earnMultiplier: "1", ...fields }))).value.errors;
    expect((await errorsFor({ name: "" })).name).toBeTruthy();
    expect((await errorsFor({ name: "x".repeat(51) })).name).toContain("50");
    expect((await errorsFor({ name: "gold" })).name).toContain("already a tier called Gold");
    expect((await errorsFor({ minSpend: "" })).minSpend).toContain("minimum spend or minimum order count");
    expect((await errorsFor({ minSpend: "-5" })).minSpend).toBeTruthy();
    expect((await errorsFor({ minSpend: "abc" })).minSpend).toBeTruthy();
    expect((await errorsFor({ minOrders: "1.5" })).minOrders).toBeTruthy();
    expect((await errorsFor({ earnMultiplier: "0" })).earnMultiplier).toBeTruthy();
    expect((await errorsFor({ earnMultiplier: "11" })).earnMultiplier).toBeTruthy();
    expect((await errorsFor({ sortOrder: "-1" })).sortOrder).toBeTruthy();
    const gold = await prisma.vipTier.findFirstOrThrow();
    expect((await call(tiers.action, post("/app/tiers", { intent: "update", id: gold.id, name: "Gold", minSpend: "5", earnMultiplier: "1" }))).value).toEqual({ ok: true });
  });
});

describe("settings", () => {
  const valid = {
    pointsPerDollar: "2",
    redemptionRate: "50",
    minRedeemablePoints: "100",
    maxRedemptionPercent: "40",
    referrerBonusPoints: "500",
    refereeBonusPoints: "250",
    referralCodeExpiryDays: "30",
    maxActiveReferralCodesPerCustomer: "5",
    referralVelocityThreshold: "50",
    referralVelocityWindowMinutes: "60",
    pointsExpiryDays: "",
    notificationWebhookUrl: "",
  };

  test("loads current values and the subscription", async () => {
    paid();
    const { value } = await call(settingsRoute.loader, get("/app/settings"));
    expect(value.values).toMatchObject({ pointsPerDollar: "1", redemptionRate: "100", pointsExpiryDays: "", notificationWebhookUrl: "" });
    expect(value.subscription).toMatchObject({ source: "billing-api", inTrial: true });
    expect(value.billingUnavailable).toBe(false);
  });

  test("shows the page with billing marked unavailable when Shopify can't be reached", async () => {
    await makeSettings({ pointsExpiryDays: 90, notificationWebhookUrl: "https://hooks.example.com" });
    shopify.billing.check.mockRejectedValue(networkError());
    const { value } = await call(settingsRoute.loader, get("/app/settings"));
    expect(value).toMatchObject({ billingUnavailable: true, subscription: null });
    expect(value.values).toMatchObject({ pointsExpiryDays: "90", notificationWebhookUrl: "https://hooks.example.com" });
  });

  test("saves valid settings and syncs them to the checkout discount", async () => {
    await makeSettings({ discountAutomaticId: "existing" });
    const { value } = await call(settingsRoute.action, post("/app/settings", { ...valid, pointsExpiryDays: "365", notificationWebhookUrl: "https://hooks.example.com/x" }));
    expect(value.errors).toBeNull();
    const saved = await prisma.shopSettings.findUniqueOrThrow({ where: { shop } });
    expect(Number(saved.pointsPerDollar)).toBe(2);
    expect(saved.pointsExpiryDays).toBe(365);
    const metafield = (shopify.admin.callsTo("SetLoyaltySettings")[0]?.variables?.metafields as { value: string }[])[0]!;
    expect(JSON.parse(metafield.value)).toMatchObject({ pointsPerDollar: 2, redemptionRate: 50, maxRedemptionPercent: 40 });
  });

  test("returns field errors for invalid values", async () => {
    await makeSettings();
    const errorsFor = async (fields: Record<string, string>) =>
      (await call(settingsRoute.action, post("/app/settings", { ...valid, ...fields }))).value.errors;
    expect(await errorsFor({ pointsPerDollar: "0" })).toHaveProperty("pointsPerDollar");
    expect(await errorsFor({ pointsPerDollar: "99999" })).toHaveProperty("pointsPerDollar");
    expect(await errorsFor({ redemptionRate: "" })).toHaveProperty("redemptionRate");
    expect(await errorsFor({ minRedeemablePoints: "1.5" })).toHaveProperty("minRedeemablePoints");
    expect(await errorsFor({ minRedeemablePoints: "9999999999" })).toHaveProperty("minRedeemablePoints");
    expect(await errorsFor({ maxRedemptionPercent: "101" })).toHaveProperty("maxRedemptionPercent");
    expect(await errorsFor({ pointsExpiryDays: "-3" })).toHaveProperty("pointsExpiryDays");
    expect(await errorsFor({ notificationWebhookUrl: "http://insecure.example.com" })).toHaveProperty("notificationWebhookUrl");
    expect(await errorsFor({ notificationWebhookUrl: "not a url" })).toHaveProperty("notificationWebhookUrl");
  });

  test("says so if the save worked but checkout didn't get the new rates", async () => {
    await makeSettings();
    shopify.admin.on("ShopId", () => networkError());
    const { value } = await call(settingsRoute.action, post("/app/settings", valid));
    expect(value.errors.redemptionRate).toContain("checkout didn't get the new rates");
  });

  test("a value the database can't store is reported, not a crash", async () => {
    await makeSettings();
    const { value } = await call(settingsRoute.action, post("/app/settings", { ...valid, redemptionRate: "999999.99", maxRedemptionPercent: "100", pointsPerDollar: "9999.99" }));
    expect(value.errors).toBeNull();
    await prisma.shopSettings.deleteMany();
    const missing = await call(settingsRoute.action, post("/app/settings", valid));
    expect(missing.value.errors.pointsPerDollar).toContain("too large");
  });

  test("cancelling ends access and sends the merchant to pick a plan", async () => {
    await getOrCreateShopSettings(shop);
    await rememberAppPricingGrant(shop, "standard");
    paid();
    const { thrown } = await call(settingsRoute.action, post("/app/settings", { intent: "cancel-subscription" }));
    expect(thrown?.headers.get("Location")).toBe("/app/billing");
    expect(shopify.billing.cancel).toHaveBeenCalledWith({ subscriptionId: "sub1", isTest: false, prorate: true });
    expect((await prisma.shopSettings.findUniqueOrThrow({ where: { shop } })).appPricingPlanHandle).toBeNull();
  });

  test("cancelling still leaves Settings if Shopify's cancel fails or there's nothing to cancel", async () => {
    paid();
    shopify.billing.cancel.mockRejectedValue(new Error("already cancelled"));
    expect((await call(settingsRoute.action, post("/app/settings", { intent: "cancel-subscription" }))).thrown?.status).toBe(302);
    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    expect((await call(settingsRoute.action, post("/app/settings", { intent: "cancel-subscription" }))).thrown?.status).toBe(302);
  });
});

describe("referrals page", () => {
  test("lists codes with stats, search, status filters and paging", async () => {
    await makeCustomer({ shopifyCustomerId: "owner", displayName: "Olivia" });
    const referee = await makeCustomer({ shopifyCustomerId: "friend", email: "friend@example.com" });
    await createReferralCode(shop, "owner", { code: "ACTIVE1", createdByMerchant: true });
    const used = await createReferralCode(shop, "owner", { code: "USED1", createdByMerchant: true });
    await prisma.referralCode.update({ where: { id: used.id }, data: { status: "REDEEMED", redeemedByCustomerId: referee.id, redeemedAt: new Date() } });
    const stale = await createReferralCode(shop, "owner", { code: "STALE1", createdByMerchant: true });
    await prisma.referralCode.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const off = await createReferralCode(shop, "owner", { code: "OFF1", createdByMerchant: true });
    await prisma.referralCode.update({ where: { id: off.id }, data: { status: "REVOKED" } });
    const marked = await createReferralCode(shop, "owner", { code: "MARKED1", createdByMerchant: true });
    await prisma.referralCode.update({ where: { id: marked.id }, data: { status: "EXPIRED" } });
    await prisma.pointTransaction.create({ data: { shop, customerId: referee.id, type: "REFERRAL_BONUS", points: 250 } });

    const all = (await call(referrals.loader, get("/app/referrals"))).value;
    expect(all.stats).toEqual({ active: 1, redeemed: 1, bonusPoints: 250 });
    expect(all.codes).toHaveLength(5);
    expect(all.codes.find((c: { code: string }) => c.code === "USED1")).toMatchObject({ status: "REDEEMED", owner: { label: "Olivia" }, redeemedBy: { label: "friend@example.com" } });
    expect(all.codes.find((c: { code: string }) => c.code === "STALE1").status).toBe("EXPIRED");

    const codesFor = async (query: string) => (await call(referrals.loader, get(`/app/referrals?${query}`))).value.codes.map((c: { code: string }) => c.code).sort();
    expect(await codesFor("status=active")).toEqual(["ACTIVE1"]);
    expect(await codesFor("status=expired")).toEqual(["MARKED1", "STALE1"]);
    expect(await codesFor("status=redeemed")).toEqual(["USED1"]);
    expect(await codesFor("status=revoked")).toEqual(["OFF1"]);
    expect(await codesFor("status=bogus")).toHaveLength(5);
    expect(await codesFor("q=olivia&status=active")).toEqual(["ACTIVE1"]);
    expect(await codesFor("q=used")).toEqual(["USED1"]);
    expect((await call(referrals.loader, get("/app/referrals?page=0"))).value.page).toBe(1);
  });

  test("labels an owner with no name or email by customer id", async () => {
    await makeCustomer({ shopifyCustomerId: "77", email: null, displayName: null });
    await createReferralCode(shop, "77", { code: "NONAME", createdByMerchant: true });
    const { value } = await call(referrals.loader, get("/app/referrals"));
    expect(value.codes[0].owner.label).toBe("Customer 77");
  });

  test("pages 50 codes at a time", async () => {
    await makeCustomer({ shopifyCustomerId: "owner" });
    for (let i = 0; i < 51; i += 1) await createReferralCode(shop, "owner", { createdByMerchant: true });
    expect((await call(referrals.loader, get("/app/referrals"))).value.hasNext).toBe(true);
    expect((await call(referrals.loader, get("/app/referrals?page=2"))).value.codes).toHaveLength(1);
  });

  test("creates a code for a Shopify customer, syncing their profile", async () => {
    shopify.admin.on("HabitCustomers", () => ({
      data: { nodes: [{ id: "gid://shopify/Customer/321", firstName: "New", lastName: "Friend", defaultEmailAddress: null, amountSpent: { amount: "0" }, numberOfOrders: 0 }] },
    }));
    const { value } = await call(referrals.action, post("/app/referrals", { intent: "create", shopifyCustomerId: "321", code: "friend10", expiresInDays: "" }));
    expect(value).toEqual({ created: "FRIEND10" });
    const code = await prisma.referralCode.findUniqueOrThrow({ where: { shop_code: { shop, code: "FRIEND10" } }, include: { owner: true } });
    expect(code.expiresAt).toBeNull();
    expect(code.owner.displayName).toBe("New Friend");
  });

  test("create: generated code with expiry; profile sync failure is tolerated", async () => {
    shopify.admin.on("HabitCustomers", () => new Error("down"));
    const { value } = await call(referrals.action, post("/app/referrals", { intent: "create", shopifyCustomerId: "321", code: "", expiresInDays: "7" }));
    expect(value.created).toMatch(/^[A-Z2-9]{8}$/);
  });

  test("create: validates the customer, expiry and code", async () => {
    const create = (fields: Record<string, string>) => call(referrals.action, post("/app/referrals", { intent: "create", shopifyCustomerId: "321", ...fields }));
    expect((await create({ shopifyCustomerId: "" })).value.errors.customer).toBeTruthy();
    expect((await create({ shopifyCustomerId: "gid://x" })).value.errors.customer).toBeTruthy();
    expect((await create({ expiresInDays: "0" })).value.errors.expiresInDays).toBeTruthy();
    expect((await create({ expiresInDays: "3651" })).value.errors.expiresInDays).toBeTruthy();
    expect((await create({ expiresInDays: "1.5" })).value.errors.expiresInDays).toBeTruthy();
    expect((await create({ code: "no" })).value.errors.code).toContain("4–24");
    await create({ code: "TAKEN" });
    expect((await create({ code: "taken" })).value.errors.code).toContain("already in use");
  });

  test("create: unexpected errors aren't swallowed", async () => {
    const { withFailingWrites } = await import("../helpers/db");
    await withFailingWrites("ReferralCode", "INSERT", async () => {
      await expect(call(referrals.action, post("/app/referrals", { intent: "create", shopifyCustomerId: "321" }))).rejects.toThrow("simulated");
    });
  });

  test("revoke only affects active codes; unknown intents do nothing", async () => {
    const code = await createReferralCode(shop, "owner", { code: "LIVE1", createdByMerchant: true });
    expect((await call(referrals.action, post("/app/referrals", { intent: "revoke", codeId: code.id }))).value).toEqual({ revoked: true });
    expect((await call(referrals.action, post("/app/referrals", { intent: "revoke", codeId: code.id }))).value).toEqual({ revoked: false });
    expect((await call(referrals.action, post("/app/referrals", { intent: "nope" }))).value).toBeNull();
    await call(referrals.action, post("/app/referrals", { intent: "revoke" }));
  });
});

describe("billing page and customer search", () => {
  test("a paid shop is sent into the app; otherwise the plan page shows", async () => {
    paid();
    expect((await call(billingRoute.loader, get("/app/billing"))).thrown?.headers.get("Location")).toBe("/app");
    clearPaidAccessCache(shop);
    expect((await call(billingRoute.loader, get("/app/billing?cancelled=1"))).value).toMatchObject({ cancelled: true, amount: 49, trialDays: 30, showHostedPlan: false });
    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    expect((await call(billingRoute.loader, get("/app/billing"))).value.cancelled).toBe(false);
  });

  test("the plan page still renders when Shopify can't be reached", async () => {
    shopify.billing.check.mockRejectedValue(networkError());
    expect((await call(billingRoute.loader, get("/app/billing"))).value).toMatchObject({ cancelled: false });
  });

  test("with App Pricing on, the hosted plan page is used", async () => {
    vi.stubEnv("SHOPIFY_APP_PRICING", "true");
    shopify.billing.check.mockResolvedValue({ hasActivePayment: false, appSubscriptions: [] });
    expect((await call(billingRoute.loader, get("/app/billing"))).thrown?.headers.get("X-Target")).toBe("_top");
    expect((await call(billingRoute.action, post("/app/billing", { intent: "hosted-plans" }))).thrown?.headers.get("Location")).toContain("pricing_plans");
    vi.unstubAllEnvs();
  });

  test("starting the trial sends the merchant to Shopify's approval page", async () => {
    shopify.admin.on("AppSubscriptionCreate", () => ({
      data: { appSubscriptionCreate: { confirmationUrl: "https://admin.shopify.com/store/x/charges/1/confirm", userErrors: [] } },
    }));
    expect((await call(billingRoute.action, post("/app/billing", {}))).thrown?.headers.get("Location")).toContain("charges/1/confirm");
  });

  test("customer search returns matches, or a friendly error", async () => {
    shopify.admin.on("HabitCustomerSearch", () => ({ data: { customers: { nodes: [{ id: "gid://shopify/Customer/1", firstName: "Ann", lastName: null, defaultEmailAddress: null }] } } }));
    expect((await call(customerSearch.loader, get("/app/customer-search?q=ann"))).value).toEqual({
      customers: [{ id: "1", email: null, displayName: "Ann" }],
      error: null,
    });
    expect(shopify.admin.callsTo("HabitCustomerSearch")[0]?.variables).toMatchObject({ query: "ann" });
    await call(customerSearch.loader, get("/app/customer-search"));
    shopify.admin.on("HabitCustomerSearch", () => new Error("down"));
    expect((await call(customerSearch.loader, get("/app/customer-search?q=x"))).value).toEqual({ customers: [], error: "Couldn't search customers. Try again." });
  });
});
