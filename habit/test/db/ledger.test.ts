import { describe, expect, test, vi } from "vitest";
import {
  awardPointsForOrder,
  checkReferralCode,
  compareTiers,
  createReferralCode,
  DAY_MS,
  expireInactiveBalances,
  finalizeRedemptionForOrder,
  getOrCreateCustomer,
  getOrCreateShopSettings,
  lastPurchaseActivity,
  normalizeReferralCode,
  previewRedemption,
  RedemptionError,
  redeemReferralCode,
  ReferralError,
  resolveVipTier,
  reverseForRefund,
} from "../../app/lib/ledger.server";
import { ledger, makeCustomer, makeSettings, makeTier, member, prisma } from "../helpers/db";
import { TEST_SHOP as shop } from "../helpers/shopify";

const A = "7001";
const B = "7002";

async function outbox() {
  return prisma.notificationOutbox.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
}

describe("shop settings and members", () => {
  test("creates default settings once and returns the same row after", async () => {
    const first = await getOrCreateShopSettings(shop);
    const second = await getOrCreateShopSettings(shop);
    expect(second.shop).toBe(first.shop);
    expect(Number(first.pointsPerDollar)).toBe(1);
    expect(Number(first.redemptionRate)).toBe(100);
    expect(first.minRedeemablePoints).toBe(100);
    expect(first.referrerBonusPoints).toBe(500);
    expect(first.refereeBonusPoints).toBe(250);
  });

  test("survives two requests creating the same shop's settings at once", async () => {
    const [a, b] = await Promise.all([getOrCreateShopSettings(shop), getOrCreateShopSettings(shop)]);
    expect(a.shop).toBe(b.shop);
    expect(await prisma.shopSettings.count()).toBe(1);
  });

  test("upserts members and only overwrites name and email when given", async () => {
    await getOrCreateCustomer(shop, A, "a@example.com", "Ann");
    await getOrCreateCustomer(shop, A);
    expect((await member(A)).email).toBe("a@example.com");
    await getOrCreateCustomer(shop, A, "new@example.com", "Ann B");
    const updated = await member(A);
    expect(updated.email).toBe("new@example.com");
    expect(updated.displayName).toBe("Ann B");
  });

  test("lastPurchaseActivity falls back to when the member joined", () => {
    const createdAt = new Date("2026-01-01");
    expect(lastPurchaseActivity({ lastActivityAt: null, createdAt })).toBe(createdAt);
    const last = new Date("2026-02-01");
    expect(lastPurchaseActivity({ lastActivityAt: last, createdAt })).toBe(last);
  });
});

describe("VIP tier ranking", () => {
  test("picks the highest qualifying tier; ties on sort order rank by threshold", async () => {
    const gold = await makeTier({ name: "Gold", minSpend: 1000, earnMultiplier: 1.5 });
    const platinum = await makeTier({ name: "Platinum", minSpend: 2500, earnMultiplier: 2 });
    const frequent = await makeTier({ name: "Frequent", minOrders: 5, earnMultiplier: 1.2 });
    const tiers = [platinum, frequent, gold];
    expect(resolveVipTier(tiers, 0, 0)).toBeNull();
    expect(resolveVipTier(tiers, 1200, 1)?.name).toBe("Gold");
    expect(resolveVipTier(tiers, 3000, 1)?.name).toBe("Platinum");
    expect(resolveVipTier(tiers, 10, 6)?.name).toBe("Frequent");
  });

  test("the merchant's sort order wins over thresholds", async () => {
    const low = await makeTier({ name: "Low bar, top rank", minSpend: 10, sortOrder: 5 });
    const high = await makeTier({ name: "High bar", minSpend: 1000, sortOrder: 1 });
    expect(resolveVipTier([low, high], 5000, 1)?.name).toBe("Low bar, top rank");
    expect([low, high].sort(compareTiers).map((t) => t.name)).toEqual(["High bar", "Low bar, top rank"]);
  });

  test("a tier needing both spend and orders requires both", async () => {
    const both = await makeTier({ name: "Both", minSpend: 100, minOrders: 3 });
    expect(resolveVipTier([both], 500, 2)).toBeNull();
    expect(resolveVipTier([both], 500, 3)?.name).toBe("Both");
  });
});

describe("awardPointsForOrder", () => {
  test("awards points per dollar, records lifetime totals, and queues events", async () => {
    await makeCustomer({ shopifyCustomerId: A, email: "a@example.com" });
    const tx = await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 123.45 });
    expect(tx?.points).toBe(123);
    const a = await member(A);
    expect(a.pointsBalance).toBe(123);
    expect(Number(a.lifetimeSpend)).toBe(123.45);
    expect(a.lifetimeOrders).toBe(1);
    expect(a.lastActivityAt).not.toBeNull();
    expect((await outbox()).map((e) => e.eventName)).toEqual(["Habit: Points Earned"]);
  });

  test("applies the current tier's multiplier, then upgrades the tier", async () => {
    await makeTier({ name: "Gold", minSpend: 100, earnMultiplier: 2 });
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, customerEmail: "a@example.com", subtotalAmount: 150 });
    let a = await member(A);
    expect(a.pointsBalance).toBe(150); // not Gold yet on this order
    expect(a.vipTier?.name).toBe("Gold");
    await awardPointsForOrder({ shop, orderId: "2", shopifyCustomerId: A, subtotalAmount: 10 });
    a = await member(A);
    expect(a.pointsBalance).toBe(170); // 10 at 2x
    const events = (await outbox()).map((e) => e.eventName);
    expect(events).toContain("Habit: Tier Upgraded");
    expect(events.filter((e) => e === "Habit: Tier Upgraded")).toHaveLength(1);
  });

  test("uses a stored tier even if thresholds changed since", async () => {
    const gold = await makeTier({ name: "Gold", minSpend: 99999, earnMultiplier: 3 });
    await makeCustomer({ shopifyCustomerId: A, vipTierId: gold.id });
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 10 });
    expect((await member(A)).pointsBalance).toBe(30);
  });

  test("a redelivered order is a no-op, even when both copies arrive at once", async () => {
    await Promise.all([
      awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 100 }),
      awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 100 }),
    ]);
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 100 });
    const a = await member(A);
    expect(a.pointsBalance).toBe(100);
    expect(a.lifetimeOrders).toBe(1);
    expect((await ledger()).filter((t) => t.type === "EARN")).toHaveLength(1);
  });

  test("two different orders for one member at once both count", async () => {
    await Promise.all([
      awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 100 }),
      awardPointsForOrder({ shop, orderId: "2", shopifyCustomerId: A, subtotalAmount: 50 }),
    ]);
    const a = await member(A);
    expect(a.pointsBalance).toBe(150);
    expect(Number(a.lifetimeSpend)).toBe(150);
    expect(a.lifetimeOrders).toBe(2);
  });

  test("a 0-point order is still recorded so it counts once, with no earned event", async () => {
    await makeCustomer({ shopifyCustomerId: A, email: "a@example.com" });
    await awardPointsForOrder({ shop, orderId: "tiny", shopifyCustomerId: A, subtotalAmount: 0.5 });
    await awardPointsForOrder({ shop, orderId: "tiny", shopifyCustomerId: A, subtotalAmount: 0.5 });
    const a = await member(A);
    expect(a.pointsBalance).toBe(0);
    expect(a.lifetimeOrders).toBe(1);
    expect((await ledger())[0]?.points).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });

  test("a member without an email gets points but no queued notifications", async () => {
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: A, subtotalAmount: 10 });
    expect(await outbox()).toHaveLength(0);
  });
});

describe("reverseForRefund", () => {
  async function paidOrder(orderId: string, customer: string, subtotal: number) {
    await awardPointsForOrder({ shop, orderId, shopifyCustomerId: customer, subtotalAmount: subtotal });
  }

  test("does nothing for an order Habit never saw", async () => {
    expect(await reverseForRefund({ shop, orderId: "unknown", refundedAmount: 10, orderSubtotal: 10 })).toEqual([]);
  });

  test("partial refunds add up to a full reversal; redelivery is a no-op", async () => {
    await paidOrder("1", A, 100);
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 50, orderSubtotal: 100 });
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 50, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(50);
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 100, orderSubtotal: 100 });
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 100, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(0);
    expect((await ledger()).filter((t) => t.type === "REFUND_REVERSAL")).toHaveLength(2);
  });

  test("a refund over the subtotal, or with no subtotal, counts as full", async () => {
    await paidOrder("1", A, 100);
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 150, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(0);
    await paidOrder("2", B, 40);
    await reverseForRefund({ shop, orderId: "2", refundedAmount: 5, orderSubtotal: 0 });
    expect((await member(B)).pointsBalance).toBe(0);
  });

  test("clawback can take a balance negative when the points were spent", async () => {
    await paidOrder("1", A, 100);
    await prisma.customer.update({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: A } }, data: { pointsBalance: 0 } });
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 100, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(-100);
  });

  test("returns points spent on the refunded order, proportionally", async () => {
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 1000 });
    await paidOrder("1", A, 100);
    await finalizeRedemptionForOrder({ shop, orderId: "1", shopifyCustomerId: A, points: 400 });
    expect((await member(A)).pointsBalance).toBe(700);
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 25, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(700 - 25 + 100);
    await reverseForRefund({ shop, orderId: "1", refundedAmount: 100, orderSubtotal: 100 });
    // Earn (+100) fully clawed back, spend (-400) fully returned.
    expect((await member(A)).pointsBalance).toBe(1000);
    const types = (await ledger()).map((t) => t.type);
    expect(types.filter((t) => t === "REDEMPTION_REFUND")).toHaveLength(2);
  });

  test("takes refunded spend out of lifetime totals and re-ranks the tier", async () => {
    await makeTier({ name: "Gold", minSpend: 1000, earnMultiplier: 1.5 });
    await paidOrder("big", A, 1700);
    expect((await member(A)).vipTier?.name).toBe("Gold");
    await reverseForRefund({ shop, orderId: "big", refundedAmount: 850, orderSubtotal: 1700 });
    let a = await member(A);
    expect(Number(a.lifetimeSpend)).toBe(850);
    expect(a.lifetimeOrders).toBe(1);
    expect(a.vipTier).toBeNull();
    await reverseForRefund({ shop, orderId: "big", refundedAmount: 1700, orderSubtotal: 1700 });
    await reverseForRefund({ shop, orderId: "big", refundedAmount: 1700, orderSubtotal: 1700 });
    a = await member(A);
    expect(Number(a.lifetimeSpend)).toBe(0);
    expect(a.lifetimeOrders).toBe(0);
    await paidOrder("next", A, 100);
    expect((await member(A)).pointsBalance).toBe(100); // 1x, not Gold
  });

  test("a full refund of a referred order reverses both bonuses once", async () => {
    await makeCustomer({ shopifyCustomerId: A });
    await createReferralCode(shop, A, { code: "FRIEND", createdByMerchant: true });
    await paidOrder("r", B, 100);
    await redeemReferralCode({ shop, code: "FRIEND", refereeShopifyCustomerId: B, orderId: "r" });
    await reverseForRefund({ shop, orderId: "r", refundedAmount: 50, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(500); // partial: bonuses stand
    await reverseForRefund({ shop, orderId: "r", refundedAmount: 100, orderSubtotal: 100 });
    await reverseForRefund({ shop, orderId: "r", refundedAmount: 100, orderSubtotal: 100 });
    expect((await member(A)).pointsBalance).toBe(0);
    expect((await member(B)).pointsBalance).toBe(0);
  });
});

describe("redemption", () => {
  test("previewRedemption enforces the minimum and the balance", async () => {
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 300 });
    await expect(previewRedemption({ shop, shopifyCustomerId: A, points: 50 })).rejects.toThrow(RedemptionError);
    await expect(previewRedemption({ shop, shopifyCustomerId: A, points: 500 })).rejects.toThrow("Not enough points");
    expect(await previewRedemption({ shop, shopifyCustomerId: A, points: 250 })).toEqual({ discountAmount: 2.5 });
  });

  test("finalize deducts once, even when delivered twice at once", async () => {
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 1000, email: "a@example.com" });
    await Promise.all([
      finalizeRedemptionForOrder({ shop, orderId: "1", shopifyCustomerId: A, points: 300 }),
      finalizeRedemptionForOrder({ shop, orderId: "1", shopifyCustomerId: A, points: 300 }),
    ]);
    expect((await member(A)).pointsBalance).toBe(700);
    expect((await outbox()).map((e) => e.eventName)).toEqual(["Habit: Points Redeemed"]);
  });

  test("finalize clamps to the balance and ignores non-positive requests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 120 });
    expect(await finalizeRedemptionForOrder({ shop, orderId: "0", shopifyCustomerId: A, points: 0 })).toBeNull();
    await finalizeRedemptionForOrder({ shop, orderId: "1", shopifyCustomerId: A, points: 500 });
    expect((await member(A)).pointsBalance).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("overdraft"));
    expect(await finalizeRedemptionForOrder({ shop, orderId: "2", shopifyCustomerId: A, points: 100 })).toBeNull();
    warn.mockRestore();
  });
});

describe("referral codes", () => {
  test("normalizeReferralCode uppercases and validates", () => {
    expect(normalizeReferralCode("  friend-10 ")).toBe("FRIEND-10");
    expect(() => normalizeReferralCode("ab")).toThrow(ReferralError);
    expect(() => normalizeReferralCode("has space")).toThrow(ReferralError);
    expect(() => normalizeReferralCode("x".repeat(25))).toThrow(ReferralError);
  });

  test("shoppers are held to the active-code limit; merchants aren't", async () => {
    await makeSettings({ maxActiveReferralCodesPerCustomer: 2 });
    await createReferralCode(shop, A);
    await createReferralCode(shop, A);
    await expect(createReferralCode(shop, A)).rejects.toThrow("at most 2");
    await expect(createReferralCode(shop, A, { createdByMerchant: true })).resolves.toBeTruthy();
  });

  test("generated codes use the shop's expiry; custom codes can have none", async () => {
    await makeSettings({ referralCodeExpiryDays: 10 });
    const generated = await createReferralCode(shop, A);
    expect(generated.code).toMatch(/^[A-Z2-9]{8}$/);
    const days = (generated.expiresAt!.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThanOrEqual(10);
    const custom = await createReferralCode(shop, A, { code: "vip-1", expiresInDays: null, createdByMerchant: true });
    expect(custom.code).toBe("VIP-1");
    expect(custom.expiresAt).toBeNull();
    const fixed = await createReferralCode(shop, A, { code: "SHORT", expiresInDays: 3, createdByMerchant: true });
    expect(Math.round((fixed.expiresAt!.getTime() - Date.now()) / DAY_MS)).toBe(3);
  });

  test("a custom code must be unused in this shop, but other shops may reuse it", async () => {
    await createReferralCode(shop, A, { code: "SAME", createdByMerchant: true });
    await expect(createReferralCode(shop, B, { code: "same", createdByMerchant: true })).rejects.toThrow("already in use");
    await expect(
      createReferralCode("other-shop.myshopify.com", A, { code: "SAME", createdByMerchant: true }),
    ).resolves.toBeTruthy();
  });

  test("regenerates a generated code that collides", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // always "AAAAAAAA"
    await createReferralCode(shop, A, { createdByMerchant: true });
    random.mockRestore();
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValueOnce(0); // first attempt collides; the rest are random
    const second = await createReferralCode(shop, A, { createdByMerchant: true });
    expect(second.code).not.toBe("AAAAAAAA");
    spy.mockRestore();
  });

  test("creating codes past the velocity threshold raises the dashboard alert", async () => {
    await makeSettings({ referralVelocityThreshold: 2, referralVelocityWindowMinutes: 60 });
    await createReferralCode(shop, A);
    expect((await getOrCreateShopSettings(shop)).referralVelocityAlertAt).toBeNull();
    await createReferralCode(shop, B);
    expect((await getOrCreateShopSettings(shop)).referralVelocityAlertAt).not.toBeNull();
  });

  test("checkReferralCode explains every rejection", async () => {
    await createReferralCode(shop, A, { code: "OWNED", createdByMerchant: true });
    await expect(checkReferralCode({ shop, code: "" })).rejects.toThrow("doesn't exist");
    await expect(checkReferralCode({ shop, code: "NOPE" })).rejects.toThrow("doesn't exist");
    await expect(checkReferralCode({ shop, code: "owned", refereeShopifyCustomerId: A })).rejects.toThrow("own referral code");
    await expect(checkReferralCode({ shop, code: " owned " })).resolves.toEqual({ code: "OWNED", refereeBonusPoints: 250 });
    await expect(checkReferralCode({ shop, code: "OWNED", refereeShopifyCustomerId: "never-seen" })).resolves.toBeTruthy();

    await makeCustomer({ shopifyCustomerId: B, lifetimeOrders: 1 });
    await expect(checkReferralCode({ shop, code: "OWNED", refereeShopifyCustomerId: B })).rejects.toThrow("first order");

    await prisma.referralCode.update({ where: { shop_code: { shop, code: "OWNED" } }, data: { status: "REVOKED" } });
    await expect(checkReferralCode({ shop, code: "OWNED" })).rejects.toThrow("no longer active");

    await createReferralCode(shop, A, { code: "STALE", createdByMerchant: true, expiresInDays: 1 });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "STALE" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(checkReferralCode({ shop, code: "STALE" })).rejects.toThrow("expired");
  });

  test("checkReferralCode rejects a customer who already used a code", async () => {
    await createReferralCode(shop, A, { code: "FIRST", createdByMerchant: true });
    await createReferralCode(shop, A, { code: "SECOND", createdByMerchant: true });
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: B, subtotalAmount: 10 });
    await redeemReferralCode({ shop, code: "FIRST", refereeShopifyCustomerId: B, orderId: "1" });
    await prisma.customer.update({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: B } }, data: { lifetimeOrders: 0 } });
    await expect(checkReferralCode({ shop, code: "SECOND", refereeShopifyCustomerId: B })).rejects.toThrow("already been used");
  });

  test("redeeming pays both bonuses, marks the code used, and queues both events", async () => {
    await makeCustomer({ shopifyCustomerId: A, email: "a@example.com" });
    await createReferralCode(shop, A, { code: "FRIEND", createdByMerchant: true });
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: B, customerEmail: "b@example.com", subtotalAmount: 10 });
    await redeemReferralCode({ shop, code: "friend", refereeShopifyCustomerId: B, orderId: "1" });
    expect((await member(A)).pointsBalance).toBe(500);
    expect((await member(B)).pointsBalance).toBe(260);
    const code = await prisma.referralCode.findUniqueOrThrow({ where: { shop_code: { shop, code: "FRIEND" } } });
    expect(code.status).toBe("REDEEMED");
    expect(code.redeemedAt).not.toBeNull();
    const events = (await outbox()).map((e) => e.eventName);
    expect(events).toEqual(expect.arrayContaining(["Habit: Referral Sent", "Habit: Referral Welcome Bonus"]));
  });

  test("redeeming the same code twice at once pays once", async () => {
    await createReferralCode(shop, A, { code: "FRIEND", createdByMerchant: true });
    await awardPointsForOrder({ shop, orderId: "1", shopifyCustomerId: B, subtotalAmount: 10 });
    const results = await Promise.allSettled([
      redeemReferralCode({ shop, code: "FRIEND", refereeShopifyCustomerId: B, orderId: "1" }),
      redeemReferralCode({ shop, code: "FRIEND", refereeShopifyCustomerId: B, orderId: "1" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await member(A)).pointsBalance).toBe(500);
  });

  test("redeeming rejects unknown, inactive, expired, self, repeat, and non-first-order use", async () => {
    await expect(redeemReferralCode({ shop, code: "NOPE", refereeShopifyCustomerId: B })).rejects.toThrow("not found");

    await createReferralCode(shop, A, { code: "PAUSED", createdByMerchant: true });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "PAUSED" } }, data: { status: "REVOKED" } });
    await expect(redeemReferralCode({ shop, code: "PAUSED", refereeShopifyCustomerId: B })).rejects.toThrow("no longer active");

    await createReferralCode(shop, A, { code: "STALE", createdByMerchant: true });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "STALE" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(redeemReferralCode({ shop, code: "STALE", refereeShopifyCustomerId: B })).rejects.toThrow("expired");
    expect((await prisma.referralCode.findUniqueOrThrow({ where: { shop_code: { shop, code: "STALE" } } })).status).toBe("EXPIRED");

    await createReferralCode(shop, A, { code: "MINE", createdByMerchant: true });
    await expect(redeemReferralCode({ shop, code: "MINE", refereeShopifyCustomerId: A })).rejects.toThrow("refer yourself");

    await makeCustomer({ shopifyCustomerId: "repeat", lifetimeOrders: 2 });
    await expect(redeemReferralCode({ shop, code: "MINE", refereeShopifyCustomerId: "repeat" })).rejects.toThrow("first order");

    await awardPointsForOrder({ shop, orderId: "b1", shopifyCustomerId: B, subtotalAmount: 10 });
    await redeemReferralCode({ shop, code: "MINE", refereeShopifyCustomerId: B, orderId: "b1" });
    await createReferralCode(shop, A, { code: "AGAIN", createdByMerchant: true });
    await prisma.customer.update({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: B } }, data: { lifetimeOrders: 1 } });
    await expect(redeemReferralCode({ shop, code: "AGAIN", refereeShopifyCustomerId: B })).rejects.toThrow("already been used");
  });
});

describe("expireInactiveBalances", () => {
  test("expires balances idle past the shop's window, once, and queues an event", async () => {
    await makeSettings({ pointsExpiryDays: 30 });
    const old = new Date(Date.now() - 40 * DAY_MS);
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 500, lastActivityAt: old, email: "a@example.com" });
    await makeCustomer({ shopifyCustomerId: B, pointsBalance: 500, lastActivityAt: new Date() });
    await makeCustomer({ shopifyCustomerId: "joined-long-ago", pointsBalance: 80, createdAt: old, email: null });
    await makeCustomer({ shopifyCustomerId: "empty", pointsBalance: 0, lastActivityAt: old });
    expect(await expireInactiveBalances()).toBe(2);
    expect(await expireInactiveBalances()).toBe(0);
    expect((await member(A)).pointsBalance).toBe(0);
    expect((await member("joined-long-ago")).pointsBalance).toBe(0);
    expect((await member(B)).pointsBalance).toBe(500);
    expect((await outbox()).map((e) => e.eventName)).toEqual(["Habit: Points Expired"]);
  });

  test("leaves shops without expiry, or with a 0-day setting, alone", async () => {
    await makeSettings({ pointsExpiryDays: null });
    await makeSettings({ pointsExpiryDays: 0 }, "zero.myshopify.com");
    const old = new Date(Date.now() - 400 * DAY_MS);
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 500, lastActivityAt: old });
    await makeCustomer({ shop: "zero.myshopify.com", shopifyCustomerId: A, pointsBalance: 500, lastActivityAt: old });
    expect(await expireInactiveBalances()).toBe(0);
  });

  test("skips a member who became active between the query and the update", async () => {
    await makeSettings({ pointsExpiryDays: 30 });
    const old = new Date(Date.now() - 40 * DAY_MS);
    await makeCustomer({ shopifyCustomerId: A, pointsBalance: 500, lastActivityAt: old });
    const findMany = prisma.customer.findMany.bind(prisma.customer);
    // Spying on the Prisma client is a last resort (spies on it leak); this
    // is the last test in the file, and each db file gets a fresh client.
    const spy = vi.spyOn(prisma.customer, "findMany").mockImplementationOnce((async (args: unknown) => {
      const rows = await findMany(args as never);
      await prisma.customer.update({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: A } }, data: { lastActivityAt: new Date() } });
      return rows;
    }) as never);
    expect(await expireInactiveBalances()).toBe(0);
    spy.mockRestore();
    expect((await member(A)).pointsBalance).toBe(500);
  });
});

describe("referral velocity check", () => {
  test("does nothing for a shop without settings", async () => {
    const { checkReferralVelocity } = await import("../../app/lib/fraud.server");
    await expect(checkReferralVelocity("no-settings.myshopify.com")).resolves.toBeUndefined();
  });
});
