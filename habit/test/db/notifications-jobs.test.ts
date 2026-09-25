import { afterEach, describe, expect, test, vi } from "vitest";
import { enqueueLoyaltyEvent, processOutbox } from "../../app/lib/notifications.server";
import { enqueueExpiringSoonEvents, runExpirePointsJob, runOutboxJob } from "../../app/lib/jobs.server";
import { purgeShopData } from "../../app/lib/shop-data.server";
import { DAY_MS } from "../../app/lib/ledger.server";
import { makeCustomer, makeSession, makeSettings, makeTier, prisma } from "../helpers/db";
import { shopify, TEST_SHOP as shop } from "../helpers/shopify";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function queue(eventName: string, properties: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  await enqueueLoyaltyEvent(prisma, {
    shop,
    eventName,
    customerEmail: "ann@example.com",
    shopifyCustomerId: "42",
    orderId: "9001",
    uniqueKey: `${eventName}:${Math.random()}`,
    properties,
    ...extra,
  });
  // Postgres rounds the default timestamp to the millisecond while JS
  // truncates, so a row written this millisecond can look 1ms in the future.
  await prisma.notificationOutbox.updateMany({ data: { availableAt: new Date(Date.now() - 1000) } });
}

async function rows() {
  return prisma.notificationOutbox.findMany({ where: { shop } });
}

function acceptFlow() {
  const handles: string[] = [];
  shopify.admin.on("FlowTriggerReceive", (variables) => {
    handles.push(String(variables?.handle));
    return { data: { flowTriggerReceive: { userErrors: [] } } };
  });
  return handles;
}

describe("enqueueLoyaltyEvent", () => {
  test("stores events once per unique key and skips members without email", async () => {
    const params = { shop, eventName: "Habit: Points Earned", customerEmail: " ann@example.com ", uniqueKey: "k1", properties: { points: 5 } };
    await enqueueLoyaltyEvent(prisma, params);
    await enqueueLoyaltyEvent(prisma, params);
    await enqueueLoyaltyEvent(prisma, { ...params, uniqueKey: "k2", customerEmail: null });
    await enqueueLoyaltyEvent(prisma, { ...params, uniqueKey: "k3", customerEmail: "   " });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ customerEmail: "ann@example.com", shopifyCustomerId: null, orderId: null, status: "PENDING" });
  });

  test("rethrows database errors other than a duplicate key", async () => {
    await expect(
      enqueueLoyaltyEvent(prisma, { shop: null as never, eventName: "x", customerEmail: "a@b.c", uniqueKey: "k", properties: {} }),
    ).rejects.toThrow();
  });
});

describe("processOutbox", () => {
  test("sends Flow triggers and marks rows sent", async () => {
    const handles = acceptFlow();
    await queue("Habit: Points Earned", { points: 10, pointsBalance: 30 });
    expect(await processOutbox()).toEqual({ claimed: 1, sent: 1, skipped: 0, failed: 0, retried: 0 });
    expect(handles).toEqual(["points-earned"]);
    expect((await rows())[0]).toMatchObject({ status: "SENT", attempts: 1, lastError: null });
  });

  test("also posts to the merchant's webhook URL", async () => {
    await makeSettings({ notificationWebhookUrl: "https://hooks.example.com/habit" });
    acceptFlow();
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await queue("Habit: Tier Upgraded", { tierName: "Gold" });
    await processOutbox();
    expect(fetchMock).toHaveBeenCalledWith("https://hooks.example.com/habit", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ eventName: "Habit: Tier Upgraded", customerEmail: "ann@example.com", properties: { tierName: "Gold" } });
  });

  test("webhook-only delivery works without a Flow trigger for the event", async () => {
    await makeSettings({ notificationWebhookUrl: "https://hooks.example.com/habit" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await queue("Custom event");
    expect((await processOutbox()).sent).toBe(1);
  });

  test("skips events with nowhere to go", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await queue("Custom event");
    expect((await processOutbox()).skipped).toBe(1);
    expect((await rows())[0]?.status).toBe("SKIPPED");
  });

  test("a partial failure still counts as sent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await makeSettings({ notificationWebhookUrl: "https://hooks.example.com/habit" });
    acceptFlow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await queue("Habit: Tier Upgraded");
    expect((await processOutbox()).sent).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Webhook responded 500"));
  });

  test("retries a failed delivery with backoff, then gives up after 8 attempts", async () => {
    shopify.admin.on("FlowTriggerReceive", () => ({ data: { flowTriggerReceive: { userErrors: [{ message: "Trigger disabled" }] } } }));
    await queue("Habit: Tier Upgraded");
    expect((await processOutbox()).retried).toBe(1);
    const row = (await rows())[0]!;
    expect(row.status).toBe("PENDING");
    expect(row.lastError).toBe("Flow: Trigger disabled");
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await prisma.notificationOutbox.update({ where: { id: row.id }, data: { attempts: 7, availableAt: new Date() } });
    expect((await processOutbox()).failed).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "FAILED", attempts: 8 });
  });

  test("a Flow event that can't build a payload fails instead of pretending to send", async () => {
    await queue("Habit: Points Earned", {}, { shopifyCustomerId: null, customerEmail: "nobody@example.com" });
    await processOutbox();
    expect((await rows())[0]?.lastError).toContain("missing customer or order id");
  });

  test("finds the customer id by email when the event didn't store one", async () => {
    await makeCustomer({ shopifyCustomerId: "77", email: "ann@example.com" });
    const handles = acceptFlow();
    await queue("Habit: Tier Upgraded", {}, { shopifyCustomerId: null });
    await processOutbox();
    expect(handles).toEqual(["tier-upgraded"]);
    const payload = shopify.admin.callsTo("FlowTriggerReceive")[0]?.variables?.payload as Record<string, unknown>;
    expect(payload.customer_id).toBe(77);
  });

  test("tolerates a non-object properties value and unknown errors", async () => {
    await makeSettings({ notificationWebhookUrl: "https://hooks.example.com/habit" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw "socket closed"; }));
    await enqueueLoyaltyEvent(prisma, { shop, eventName: "Custom", customerEmail: "a@b.c", uniqueKey: "k", properties: [1, 2] as never });
    await prisma.notificationOutbox.updateMany({ data: { availableAt: new Date(Date.now() - 1000) } });
    await processOutbox();
    expect((await rows())[0]?.lastError).toBe("Webhook: Webhook failed");
  });

  test("a Flow call that throws a non-Error is recorded generically", async () => {
    shopify.admin.on("FlowTriggerReceive", () => { throw "boom"; });
    await queue("Habit: Tier Upgraded");
    await processOutbox();
    expect((await rows())[0]?.lastError).toBe("Flow: Flow trigger failed");
  });

  test("two runs at once deliver each row once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await queue("Custom event");
    const [first, second] = await Promise.all([processOutbox(), processOutbox()]);
    expect(first.skipped + second.skipped).toBe(1);
    expect((await rows())[0]?.attempts).toBe(1);
  });

  test("leaves future and non-pending rows alone", async () => {
    await queue("Custom event");
    await prisma.notificationOutbox.updateMany({ data: { availableAt: new Date(Date.now() + DAY_MS) } });
    expect((await processOutbox()).claimed).toBe(0);
  });
});

describe("jobs", () => {
  test("runOutboxJob delivers events and syncs dirty balances", async () => {
    await makeSession(shop);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await queue("Custom event");
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5 });
    shopify.admin.on("SetPointsBalances", (variables) => ({
      data: { metafieldsSet: { metafields: (variables?.metafields as { ownerId: string }[]).map((m) => ({ owner: { id: m.ownerId } })), userErrors: [] } },
    }));
    expect(await runOutboxJob()).toEqual({ claimed: 1, sent: 0, skipped: 1, failed: 0, retried: 0, balancesSynced: 1 });
  });

  test("runExpirePointsJob expires idle balances and warns those about to expire", async () => {
    await makeSettings({ pointsExpiryDays: 30 });
    await makeCustomer({ shopifyCustomerId: "idle", pointsBalance: 100, lastActivityAt: new Date(Date.now() - 40 * DAY_MS), email: null });
    await makeCustomer({ shopifyCustomerId: "soon", pointsBalance: 100, lastActivityAt: new Date(Date.now() - 25 * DAY_MS) });
    await makeCustomer({ shopifyCustomerId: "fresh", pointsBalance: 100, lastActivityAt: new Date() });
    await makeCustomer({ shopifyCustomerId: "new-soon", pointsBalance: 50, createdAt: new Date(Date.now() - 26 * DAY_MS) });
    expect(await runExpirePointsJob()).toEqual({ expired: 1, expiringSoon: 2 });
    // Same day again: the expiring-soon events are keyed by date, so no duplicates.
    await enqueueExpiringSoonEvents();
    expect(await prisma.notificationOutbox.count({ where: { eventName: "Habit: Points Expiring Soon" } })).toBe(2);
  });

  test("expiring-soon skips shops without expiry and members out of the 7-day window", async () => {
    await makeSettings({ pointsExpiryDays: null });
    await makeSettings({ pointsExpiryDays: 0 }, "zero.myshopify.com");
    await makeSettings({ pointsExpiryDays: 30 }, "window.myshopify.com");
    await makeCustomer({ shopifyCustomerId: "a", pointsBalance: 10, lastActivityAt: new Date(Date.now() - 20 * DAY_MS), shop: "window.myshopify.com" });
    expect(await enqueueExpiringSoonEvents()).toBe(0);
  });
});

describe("purgeShopData", () => {
  test("removes everything for the shop and nothing for others", async () => {
    await makeSettings();
    await makeSession(shop);
    await makeTier();
    const c = await makeCustomer();
    await prisma.pointTransaction.create({ data: { shop, customerId: c.id, type: "EARN", points: 5 } });
    await prisma.referralCode.create({ data: { shop, code: "PURGE", ownerId: c.id } });
    await queue("Custom event");
    const other = await makeCustomer({ shop: "keep.myshopify.com" });
    await purgeShopData(shop);
    for (const model of ["pointTransaction", "referralCode", "customer", "vipTier", "notificationOutbox", "shopSettings", "session"] as const) {
      expect(await (prisma[model] as { count: (a: object) => Promise<number> }).count({ where: { shop } })).toBe(0);
    }
    expect(await prisma.customer.count({ where: { id: other.id } })).toBe(1);
  });
});
