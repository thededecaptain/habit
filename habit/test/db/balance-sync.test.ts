import { describe, expect, test, vi } from "vitest";
import { POINTS_BALANCE_KEY, sweepPointsBalances, syncPointsBalances } from "../../app/lib/balance-sync.server";
import { makeCustomer, makeSession, member, prisma } from "../helpers/db";
import { createFakeAdmin, shopify, shopifyServerModule, TEST_SHOP as shop } from "../helpers/shopify";

type MetafieldInput = { ownerId: string; namespace: string; key: string; type: string; value: string };

/** Answers metafieldsSet like Shopify: echoes owners, optionally rejecting some. */
function acceptWrites(admin = shopify.admin, reject: (m: MetafieldInput) => boolean = () => false) {
  const written: MetafieldInput[] = [];
  admin.on("SetPointsBalances", (variables) => {
    const metafields = (variables?.metafields ?? []) as MetafieldInput[];
    written.push(...metafields);
    const ok = metafields.filter((m) => !reject(m));
    return {
      data: {
        metafieldsSet: {
          metafields: ok.map((m) => ({ owner: { id: m.ownerId } })),
          userErrors: metafields.filter(reject).map(() => ({ field: ["ownerId"], message: "Owner does not exist" })),
        },
      },
    };
  });
  return written;
}

describe("syncPointsBalances", () => {
  test("writes dirty balances as app-owned integer metafields, floored at 0", async () => {
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 250 });
    await makeCustomer({ shopifyCustomerId: "2", pointsBalance: -40 });
    await makeCustomer({ shopifyCustomerId: "3", pointsBalance: 10, syncedPointsBalance: 10 });
    const written = acceptWrites();
    expect(await syncPointsBalances(shop)).toBe(2);
    expect(written).toHaveLength(2);
    expect(written).toEqual(
      expect.arrayContaining([
        { ownerId: "gid://shopify/Customer/1", namespace: "$app", key: POINTS_BALANCE_KEY, type: "number_integer", value: "250" },
        { ownerId: "gid://shopify/Customer/2", namespace: "$app", key: POINTS_BALANCE_KEY, type: "number_integer", value: "0" },
      ]),
    );
    expect((await member("1")).syncedPointsBalance).toBe(250);
    expect((await member("2")).syncedPointsBalance).toBe(-40);
    expect(await syncPointsBalances(shop)).toBe(0);
  });

  test("uses the shop's offline session when no admin client is passed", async () => {
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    acceptWrites();
    await syncPointsBalances(shop);
    expect(shopifyServerModule.unauthenticated.admin).toHaveBeenCalledWith(shop);
  });

  test("an explicit admin client and customer filter are respected", async () => {
    const a = await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    await makeCustomer({ shopifyCustomerId: "2", pointsBalance: 6 });
    const admin = createFakeAdmin();
    const written = acceptWrites(admin);
    expect(await syncPointsBalances(shop, { admin, customerIds: [a.id] })).toBe(1);
    expect(written.map((m) => m.value)).toEqual(["5"]);
    expect(shopifyServerModule.unauthenticated.admin).not.toHaveBeenCalled();
  });

  test("writes in batches of 25 and respects the limit", async () => {
    for (let i = 0; i < 30; i += 1) await makeCustomer({ shopifyCustomerId: String(100 + i), pointsBalance: i });
    acceptWrites();
    expect(await syncPointsBalances(shop, { limit: 27 })).toBe(27);
    expect(shopify.admin.callsTo("SetPointsBalances").map((c) => (c.variables?.metafields as unknown[]).length)).toEqual([25, 2]);
  });

  test("a customer Shopify rejects stays dirty; the rest are marked synced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    await makeCustomer({ shopifyCustomerId: "deleted", pointsBalance: 6 });
    acceptWrites(shopify.admin, (m) => m.ownerId.endsWith("deleted"));
    expect(await syncPointsBalances(shop)).toBe(1);
    expect((await member("deleted")).syncedPointsBalance).toBeNull();
    expect(warn).toHaveBeenCalledWith("Points balance metafield userErrors", expect.any(Array));
    warn.mockRestore();
  });

  test("records the value written, so a balance that moved mid-write stays dirty", async () => {
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    shopify.admin.on("SetPointsBalances", async (variables) => {
      await prisma.customer.update({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: "1" } }, data: { pointsBalance: 99 } });
      const metafields = variables?.metafields as MetafieldInput[];
      return { data: { metafieldsSet: { metafields: metafields.map((m) => ({ owner: { id: m.ownerId } })), userErrors: [] } } };
    });
    await syncPointsBalances(shop);
    expect((await member("1")).syncedPointsBalance).toBe(5);
    acceptWrites();
    expect(await syncPointsBalances(shop)).toBe(1);
    expect((await member("1")).syncedPointsBalance).toBe(99);
  });

  test("never throws: a missing scope or network failure logs one line and returns 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    shopify.admin.on("SetPointsBalances", () => new Error("Access denied for metafieldsSet field. Required access: write_customers"));
    expect(await syncPointsBalances(shop)).toBe(0);
    expect(warn).toHaveBeenCalledWith(`Points balance sync failed for ${shop}: Access denied for metafieldsSet field`);
    shopifyServerModule.unauthenticated.admin.mockRejectedValueOnce("offline session missing");
    expect(await syncPointsBalances(shop)).toBe(0);
    expect(warn).toHaveBeenLastCalledWith(`Points balance sync failed for ${shop}: offline session missing`);
    warn.mockRestore();
  });

  test("copes with an empty metafieldsSet response", async () => {
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    expect(await syncPointsBalances(shop)).toBe(0);
  });
});

describe("sweepPointsBalances", () => {
  test("syncs every installed shop with dirty balances and skips uninstalled ones", async () => {
    await makeSession(shop);
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    await makeCustomer({ shop: "gone.myshopify.com", shopifyCustomerId: "1", pointsBalance: 7 });
    acceptWrites();
    expect(await sweepPointsBalances()).toBe(1);
    expect(shopifyServerModule.unauthenticated.admin).toHaveBeenCalledTimes(1);
    expect(shopifyServerModule.unauthenticated.admin).toHaveBeenCalledWith(shop);
  });

  test("does nothing when everything is in sync", async () => {
    await makeSession(shop);
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5, syncedPointsBalance: 5 });
    expect(await sweepPointsBalances()).toBe(0);
    expect(shopifyServerModule.unauthenticated.admin).not.toHaveBeenCalled();
  });
});
