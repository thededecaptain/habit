import { describe, expect, test, vi } from "vitest";
import {
  computeExpiresInDays,
  fetchShopifyCustomers,
  getLoyaltySnapshot,
  nextTierProgress,
  ratesPayload,
  searchShopifyCustomers,
  syncCustomersFromShopify,
} from "../../app/lib/loyalty.server";
import { createReferralCode, DAY_MS, getOrCreateShopSettings } from "../../app/lib/ledger.server";
import { makeCustomer, makeSettings, makeTier, member, prisma } from "../helpers/db";
import { createFakeAdmin, TEST_SHOP as shop } from "../helpers/shopify";

const A = "8001";

function customerNode(id: string, extra: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Customer/${id}`,
    firstName: "Ann",
    lastName: "Lee",
    defaultEmailAddress: { emailAddress: "ann@example.com" },
    amountSpent: { amount: "250.00" },
    numberOfOrders: 3,
    ...extra,
  };
}

describe("tier progress and rates", () => {
  test("nextTierProgress reports what's left to the next tier", async () => {
    const silver = await makeTier({ name: "Silver", minSpend: 100 });
    const gold = await makeTier({ name: "Gold", minSpend: 500, minOrders: 5 });
    expect(nextTierProgress([gold, silver], null, 40, 1)).toEqual({
      nextTierName: "Silver",
      nextTierRemainingSpend: 60,
      nextTierRemainingOrders: null,
    });
    expect(nextTierProgress([gold, silver], silver, 700, 2)).toEqual({
      nextTierName: "Gold",
      nextTierRemainingSpend: 0,
      nextTierRemainingOrders: 3,
    });
    expect(nextTierProgress([gold, silver], gold, 900, 9)).toEqual({
      nextTierName: null,
      nextTierRemainingSpend: null,
      nextTierRemainingOrders: null,
    });
  });

  test("ratesPayload exposes only the public rates", async () => {
    const settings = await getOrCreateShopSettings(shop);
    expect(ratesPayload(settings)).toEqual({
      loggedIn: false,
      pointsPerDollar: 1,
      redemptionRate: 100,
      minRedeemablePoints: 100,
      maxRedemptionPercent: 50,
    });
  });

  test("computeExpiresInDays counts days left, or null without expiry", () => {
    expect(computeExpiresInDays(null, new Date())).toBeNull();
    expect(computeExpiresInDays(30, new Date(Date.now() - 20 * DAY_MS))).toBe(10);
  });
});

describe("Shopify customer lookups", () => {
  test("fetchShopifyCustomers maps nodes by numeric id and skips blanks", async () => {
    const admin = createFakeAdmin().on("HabitCustomers", () => ({
      data: { nodes: [customerNode(A), null, { id: null }, customerNode("9", { firstName: null, lastName: null, defaultEmailAddress: null, amountSpent: null, numberOfOrders: null })] },
    }));
    const map = await fetchShopifyCustomers(admin, [A, `gid://shopify/Customer/${A}`, "", "9"]);
    expect(admin.callsTo("HabitCustomers")[0]?.variables).toEqual({
      ids: [`gid://shopify/Customer/${A}`, "gid://shopify/Customer/9"],
    });
    expect(map.get(A)).toEqual({ id: A, email: "ann@example.com", displayName: "Ann Lee", amountSpent: 250, numberOfOrders: 3 });
    expect(map.get("9")).toEqual({ id: "9", email: null, displayName: null, amountSpent: 0, numberOfOrders: 0 });
  });

  test("fetchShopifyCustomers skips the call when there's nothing to fetch", async () => {
    const admin = createFakeAdmin();
    expect((await fetchShopifyCustomers(admin, [""])).size).toBe(0);
    expect(admin.calls).toHaveLength(0);
  });

  test("syncCustomersFromShopify fills the profile and never lowers lifetime totals", async () => {
    await makeTier({ name: "Silver", minSpend: 200 });
    await makeCustomer({ shopifyCustomerId: A, lifetimeSpend: 400, lifetimeOrders: 1, email: null, displayName: null });
    const admin = createFakeAdmin().on("HabitCustomers", () => ({ data: { nodes: [customerNode(A)] } }));
    await syncCustomersFromShopify(shop, admin, [A]);
    const a = await member(A);
    expect(a.email).toBe("ann@example.com");
    expect(a.displayName).toBe("Ann Lee");
    expect(Number(a.lifetimeSpend)).toBe(400);
    expect(a.lifetimeOrders).toBe(3);
    expect(a.vipTier?.name).toBe("Silver");
  });

  test("syncCustomersFromShopify keeps a stored name when Shopify has none", async () => {
    await makeCustomer({ shopifyCustomerId: A, email: "keep@example.com", displayName: "Keep" });
    const admin = createFakeAdmin().on("HabitCustomers", () => ({
      data: { nodes: [customerNode(A, { firstName: null, lastName: null, defaultEmailAddress: null })] },
    }));
    await syncCustomersFromShopify(shop, admin, [A]);
    expect((await member(A)).displayName).toBe("Keep");
    expect((await member(A)).email).toBe("keep@example.com");
  });

  test("searchShopifyCustomers passes the query and maps results", async () => {
    const admin = createFakeAdmin().on("HabitCustomerSearch", () => ({
      data: { customers: { nodes: [customerNode(A), { id: null }, customerNode("5", { defaultEmailAddress: null })] } },
    }));
    const results = await searchShopifyCustomers(admin, "  ann ");
    expect(admin.callsTo("HabitCustomerSearch")[0]?.variables).toEqual({ first: 10, query: "ann" });
    expect(results).toEqual([
      { id: A, email: "ann@example.com", displayName: "Ann Lee" },
      { id: "5", email: null, displayName: "Ann Lee" },
    ]);
    await searchShopifyCustomers(admin, "", 3);
    expect(admin.callsTo("HabitCustomerSearch")[1]?.variables).toEqual({ first: 3, query: null });
  });

  test("searchShopifyCustomers copes with an empty response", async () => {
    expect(await searchShopifyCustomers(createFakeAdmin(), "x")).toEqual([]);
  });
});

describe("getLoyaltySnapshot", () => {
  test("creates a member on first view and reports rates and progress", async () => {
    await makeSettings({ pointsExpiryDays: 60 });
    await makeTier({ name: "Silver", minSpend: 100 });
    const card = await getLoyaltySnapshot(shop, A);
    expect(card).toMatchObject({
      loggedIn: true,
      pointsBalance: 0,
      balanceValue: 0,
      earnMultiplier: 1,
      tierName: null,
      nextTierName: "Silver",
      nextTierRemainingSpend: 100,
      referralCode: null,
      expiresInDays: 60,
    });
    expect(card).not.toHaveProperty("history");
    expect(await prisma.customer.count()).toBe(1);
  });

  test("includes tier, active unexpired referral code, and recent history", async () => {
    const gold = await makeTier({ name: "Gold", minSpend: 10, earnMultiplier: 2 });
    const owner = await makeCustomer({ shopifyCustomerId: A, pointsBalance: 450, vipTierId: gold.id, lifetimeSpend: 50 });
    await createReferralCode(shop, A, { code: "OLDCODE", createdByMerchant: true });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "OLDCODE" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await createReferralCode(shop, A, { code: "LIVECODE", createdByMerchant: true, expiresInDays: null });
    for (let i = 0; i < 10; i += 1) {
      await prisma.pointTransaction.create({ data: { shop, customerId: owner.id, type: "EARN", points: i, description: `#${i}` } });
    }
    const card = await getLoyaltySnapshot(shop, A, { includeHistory: true });
    expect(card).toMatchObject({ pointsBalance: 450, balanceValue: 4.5, tierName: "Gold", earnMultiplier: 2, referralCode: "LIVECODE", expiresInDays: null });
    expect(card.history).toHaveLength(8);
  });

  test("with an admin client, syncs a member missing a name or email", async () => {
    await makeCustomer({ shopifyCustomerId: A, email: null, displayName: null });
    const admin = createFakeAdmin().on("HabitCustomers", () => ({ data: { nodes: [customerNode(A)] } }));
    await getLoyaltySnapshot(shop, A, { admin });
    expect((await member(A)).displayName).toBe("Ann Lee");

    // A complete profile doesn't hit Shopify again.
    await getLoyaltySnapshot(shop, A, { admin });
    expect(admin.callsTo("HabitCustomers")).toHaveLength(1);
  });

  test("a failed profile sync doesn't break the snapshot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = createFakeAdmin().on("HabitCustomers", () => new Error("boom"));
    const card = await getLoyaltySnapshot(shop, A, { admin });
    expect(card.loggedIn).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("falls back to a redemption rate of 1 if the stored rate is 0", async () => {
    await makeSettings({ redemptionRate: 0 });
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 7 });
    expect((await getLoyaltySnapshot(shop, A)).balanceValue).toBe(7);
  });
});
