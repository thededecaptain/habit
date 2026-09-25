import crypto from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildFlowPayload, emitFlowTrigger, FLOW_TRIGGER_HANDLES } from "../../app/lib/flow.server";
import { LOYALTY_EVENT_NAMES } from "../../app/lib/loyalty-events.server";
import { authenticateWebhookSafe } from "../../app/lib/webhook-auth.server";
import { allowExtensionUserAgent, shopFromSessionTokenDest } from "../../app/lib/extension-request.server";
import { trialEndsAt, STANDARD_PLAN_AMOUNT, USAGE_BILLING_ENABLED } from "../../app/lib/billing-plan";
import { docsHref, DOCS_URL, SUPPORT_MAILTO } from "../../app/lib/brand";
import { createFakeAdmin, shopifyServerModule } from "../helpers/shopify";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Flow payloads", () => {
  const base = { customerEmail: "ann@example.com", shopifyCustomerId: "42", orderId: "9001" };

  test("every loyalty event has a Flow trigger handle", () => {
    for (const name of LOYALTY_EVENT_NAMES) expect(FLOW_TRIGGER_HANDLES[name]).toBeTruthy();
  });

  test("builds each event's payload with numbers coerced safely", () => {
    expect(buildFlowPayload({ ...base, eventName: "Habit: Points Earned", properties: { points: "12", pointsBalance: 40 } })).toEqual({
      customer_id: 42, "Customer email": "ann@example.com", order_id: 9001, Points: 12, "Points balance": 40,
    });
    expect(buildFlowPayload({ ...base, eventName: "Habit: Points Redeemed", orderId: null, properties: { orderId: "77", points: 5, pointsBalance: "x" } })).toMatchObject({
      order_id: 77, Points: 5, "Points balance": 0,
    });
    expect(buildFlowPayload({ ...base, eventName: "Habit: Tier Upgraded", properties: { tierName: "Gold", lifetimeSpend: 10, lifetimeOrders: 2 } })).toMatchObject({
      "Tier name": "Gold", "Lifetime spend": 10, "Lifetime orders": 2,
    });
    expect(buildFlowPayload({ ...base, eventName: "Habit: Tier Upgraded", properties: {} })).toMatchObject({ "Tier name": "" });
    for (const eventName of ["Habit: Referral Sent", "Habit: Referral Welcome Bonus"]) {
      expect(buildFlowPayload({ ...base, eventName, properties: { bonusPoints: 500, code: "FRIEND" } })).toMatchObject({
        "Bonus points": 500, "Referral code": "FRIEND",
      });
    }
    expect(buildFlowPayload({ ...base, eventName: "Habit: Points Expiring Soon", properties: { pointsBalance: 9, expiresInDays: 3, expiresOn: "2026-10-01" } })).toMatchObject({
      "Expires in days": 3, "Expires on": "2026-10-01",
    });
    expect(buildFlowPayload({ ...base, eventName: "Habit: Points Expired", properties: { pointsExpired: 100 } })).toMatchObject({ "Points expired": 100 });
  });

  test("returns null when Flow couldn't use the payload", () => {
    expect(buildFlowPayload({ ...base, shopifyCustomerId: null, eventName: "Habit: Points Expired", properties: {} })).toBeNull();
    expect(buildFlowPayload({ ...base, shopifyCustomerId: "abc", eventName: "Habit: Points Expired", properties: {} })).toBeNull();
    expect(buildFlowPayload({ ...base, orderId: "", eventName: "Habit: Points Earned", properties: {} })).toBeNull();
    expect(buildFlowPayload({ ...base, orderId: null, eventName: "Habit: Points Redeemed", properties: {} })).toBeNull();
    expect(buildFlowPayload({ ...base, eventName: "Something else", properties: {} })).toBeNull();
  });

  test("emitFlowTrigger sends the trigger and surfaces user errors", async () => {
    const admin = createFakeAdmin().on("FlowTriggerReceive", () => ({ data: { flowTriggerReceive: { userErrors: [] } } }));
    await emitFlowTrigger(admin as never, "points-earned", { customer_id: 1 });
    expect(admin.callsTo("FlowTriggerReceive")[0]?.variables).toEqual({ handle: "points-earned", payload: { customer_id: 1 } });
    admin.on("FlowTriggerReceive", () => ({ data: { flowTriggerReceive: { userErrors: [{ message: "A" }, { message: "B" }] } } }));
    await expect(emitFlowTrigger(admin as never, "x", {})).rejects.toThrow("A; B");
    admin.on("FlowTriggerReceive", () => ({}));
    await expect(emitFlowTrigger(admin as never, "x", {})).resolves.toBeUndefined();
  });
});

describe("authenticateWebhookSafe", () => {
  function signedRequest(body: string, headers: Record<string, string> = {}, method = "POST") {
    const hmac = crypto.createHmac("sha256", "test-api-secret").update(body, "utf8").digest("base64");
    return new Request("https://habit.test/webhooks/shop/redact", {
      method,
      body: method === "POST" ? body : undefined,
      headers: {
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-topic": "shop/redact",
        "x-shopify-shop-domain": "gone.myshopify.com",
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": "w1",
        ...headers,
      },
    });
  }

  test("uses Shopify's normal webhook auth when it works", async () => {
    shopifyServerModule.authenticate.webhook.mockResolvedValue({ shop: "a.myshopify.com", topic: "SHOP_REDACT", payload: {} });
    expect((await authenticateWebhookSafe(signedRequest("{}"))).shop).toBe("a.myshopify.com");
  });

  test("passes through 400/401/405 from Shopify's auth", async () => {
    for (const status of [400, 401, 405]) {
      shopifyServerModule.authenticate.webhook.mockRejectedValueOnce(new Response(null, { status }));
      await expect(authenticateWebhookSafe(signedRequest("{}"))).rejects.toMatchObject({ status });
    }
  });

  test("falls back to HMAC-only auth when the token refresh fails after uninstall", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shopifyServerModule.authenticate.webhook.mockRejectedValue(new Response(null, { status: 500 }));
    const result = await authenticateWebhookSafe(signedRequest(JSON.stringify({ shop_id: 1 })));
    expect(result).toEqual({ shop: "gone.myshopify.com", topic: "SHOP_REDACT", payload: { shop_id: 1 }, session: undefined, admin: undefined });

    shopifyServerModule.authenticate.webhook.mockRejectedValue(new Error("InvalidJwtError"));
    expect((await authenticateWebhookSafe(signedRequest(""))).payload).toEqual({});
  });

  test("the fallback still rejects bad signatures, missing headers, and non-POST", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shopifyServerModule.authenticate.webhook.mockRejectedValue(new Error("refresh failed"));
    await expect(authenticateWebhookSafe(signedRequest("{}", { "x-shopify-hmac-sha256": "forged" }))).rejects.toMatchObject({ status: 401 });
    const sameLength = crypto.createHmac("sha256", "wrong-secret").update("{}", "utf8").digest("base64");
    await expect(authenticateWebhookSafe(signedRequest("{}", { "x-shopify-hmac-sha256": sameLength }))).rejects.toMatchObject({ status: 401 });
    await expect(authenticateWebhookSafe(signedRequest("{}", { "x-shopify-webhook-id": "" }))).rejects.toMatchObject({ status: 400 });
    await expect(authenticateWebhookSafe(signedRequest("", {}, "GET"))).rejects.toMatchObject({ status: 405 });
  });

  test("the fallback treats an unset secret as empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shopifyServerModule.authenticate.webhook.mockRejectedValue(new Error("refresh failed"));
    const secret = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;
    await expect(authenticateWebhookSafe(signedRequest("{}"))).rejects.toMatchObject({ status: 401 });
    process.env.SHOPIFY_API_SECRET = secret;
  });
});

describe("extension requests", () => {
  test("relabels the user agent so bot filtering can't block our own extensions", () => {
    const request = allowExtensionUserAgent(
      new Request("https://habit.test/checkout-api/points?x=1", { headers: { "User-Agent": "Electron/30", Authorization: "Bearer t" } }),
    );
    expect(request.headers.get("User-Agent")).toBe("Shopify Mobile/habit-extension");
    expect(request.headers.get("Authorization")).toBe("Bearer t");
    expect(request.url).toBe("https://habit.test/checkout-api/points?x=1");
  });

  test("answers 400 for a request whose URL can't be rebuilt", () => {
    const broken = { url: "not a url", method: "GET", headers: new Headers() } as unknown as Request;
    expect(() => allowExtensionUserAgent(broken)).toThrow(Response);
  });

  test("rethrows unexpected errors", () => {
    const weird = { get url() { throw new Error("boom"); }, method: "GET", headers: new Headers() } as unknown as Request;
    expect(() => allowExtensionUserAgent(weird)).toThrow("boom");
  });

  test("reads the shop from the session token's dest, full URL or bare domain", () => {
    expect(shopFromSessionTokenDest("https://cool.myshopify.com")).toBe("cool.myshopify.com");
    expect(shopFromSessionTokenDest("cool.myshopify.com")).toBe("cool.myshopify.com");
    expect(shopFromSessionTokenDest("cool.myshopify.com/admin")).toBe("cool.myshopify.com");
    for (const bad of [undefined, "", "https://evil.example.com"]) {
      expect(() => shopFromSessionTokenDest(bad)).toThrow(Response);
    }
  });
});

describe("plan and brand constants", () => {
  test("trialEndsAt adds whole UTC days", () => {
    expect(trialEndsAt("2026-01-30T12:00:00Z", 30).toISOString()).toBe("2026-03-01T12:00:00.000Z");
  });

  test("plan and links are what the listing promises", () => {
    expect(STANDARD_PLAN_AMOUNT).toBe(49);
    expect(USAGE_BILLING_ENABLED).toBe(false);
    expect(docsHref()).toBe(`${DOCS_URL}/`);
    expect(docsHref("/program/points")).toBe(`${DOCS_URL}/program/points`);
    expect(SUPPORT_MAILTO).toBe("mailto:support@gethabitloyalty.com");
  });
});
