import { beforeEach, describe, expect, test } from "vitest";
import * as ordersPaid from "../../app/routes/webhooks.orders.paid";
import * as refundsCreate from "../../app/routes/webhooks.refunds.create";
import * as appUninstalled from "../../app/routes/webhooks.app.uninstalled";
import * as customersRedact from "../../app/routes/webhooks.customers.redact";
import * as customersDataRequest from "../../app/routes/webhooks.customers.data_request";
import * as shopRedact from "../../app/routes/webhooks.shop.redact";
import * as subscriptionsUpdate from "../../app/routes/webhooks.app.subscriptions_update";
import * as scopesUpdate from "../../app/routes/webhooks.app.scopes_update";
import * as legacyOrdersPaid from "../../app/routes/app.webhooks.orders.paid";
import * as legacyRefunds from "../../app/routes/app.webhooks.refunds.create";
import * as legacyUninstalled from "../../app/routes/app.webhooks.app.uninstalled";
import * as legacyRedact from "../../app/routes/app.webhooks.customers.redact";
import * as legacyDataRequest from "../../app/routes/app.webhooks.customers.data_request";
import * as legacyShopRedact from "../../app/routes/app.webhooks.shop.redact";
import * as legacySubscriptions from "../../app/routes/app.webhooks.app.subscriptions_update";
import * as legacyScopes from "../../app/routes/app.webhooks.app.scopes_update";
import { createReferralCode, getOrCreateShopSettings } from "../../app/lib/ledger.server";
import { loadAppPricingGrant, rememberAppPricingGrant } from "../../app/lib/app-pricing.server";
import { ledger, makeCustomer, makeSession, makeSettings, member, prisma, withFailingWrites } from "../helpers/db";
import { networkError, shopify, shopifyServerModule, TEST_SHOP as shop, webhookContext } from "../helpers/shopify";
import { call, quiet } from "../helpers/routes";

const request = () => new Request("https://habit.test/webhooks", { method: "POST" });
const CUSTOMER = { id: 555, email: "buyer@example.com" };

beforeEach(() => {
  quiet();
  // Every webhook ends by syncing balances; accept those writes.
  shopify.admin.on("SetPointsBalances", (variables) => ({
    data: { metafieldsSet: { metafields: (variables?.metafields as { ownerId: string }[]).map((m) => ({ owner: { id: m.ownerId } })), userErrors: [] } },
  }));
});

function order(overrides: Record<string, unknown> = {}) {
  return { id: 1001, customer: CUSTOMER, current_subtotal_price: "100.00", note_attributes: [], ...overrides };
}

function loyaltyDiscount(amount: string, title = "Loyalty points redeemed") {
  return {
    discount_applications: [{ type: "automatic", title, value: amount }],
    line_items: [{ discount_allocations: [{ amount, discount_application_index: 0 }] }],
  };
}

test("legacy /app/webhooks/* URLs run the same handlers", () => {
  expect(legacyOrdersPaid.action).toBe(ordersPaid.action);
  expect(legacyRefunds.action).toBe(refundsCreate.action);
  expect(legacyUninstalled.action).toBe(appUninstalled.action);
  expect(legacyRedact.action).toBe(customersRedact.action);
  expect(legacyDataRequest.action).toBe(customersDataRequest.action);
  expect(legacyShopRedact.action).toBe(shopRedact.action);
  expect(legacySubscriptions.action).toBe(subscriptionsUpdate.action);
  expect(legacyScopes.action).toBe(scopesUpdate.action);
});

describe("orders/paid", () => {
  test("awards points and syncs the new balance to Shopify", async () => {
    webhookContext("ORDERS_PAID", order());
    const { value } = await call(ordersPaid.action, request());
    expect(value.status).toBe(200);
    const buyer = await member("555");
    expect(buyer.pointsBalance).toBe(100);
    expect(buyer.email).toBe("buyer@example.com");
    expect(buyer.syncedPointsBalance).toBe(100);
  });

  test("falls back to subtotal_price, then 0", async () => {
    webhookContext("ORDERS_PAID", order({ current_subtotal_price: undefined, subtotal_price: "42.00" }));
    await call(ordersPaid.action, request());
    expect((await member("555")).pointsBalance).toBe(42);
    webhookContext("ORDERS_PAID", order({ id: 2, current_subtotal_price: undefined }));
    await call(ordersPaid.action, request());
    expect((await member("555")).lifetimeOrders).toBe(2);
  });

  test("skips guest orders, orders without an id, and missing sessions", async () => {
    for (const payload of [order({ customer: null }), order({ id: undefined })]) {
      webhookContext("ORDERS_PAID", payload);
      expect((await call(ordersPaid.action, request())).value.status).toBe(200);
    }
    webhookContext("ORDERS_PAID", order(), { session: false });
    await call(ordersPaid.action, request());
    expect(await prisma.customer.count()).toBe(0);
  });

  test("deducts the points the loyalty discount was worth, capped at the request", async () => {
    await makeCustomer({ shopifyCustomerId: "555", pointsBalance: 1000 });
    webhookContext("ORDERS_PAID", order({ ...loyaltyDiscount("4.33"), note_attributes: [{ name: "points_to_redeem", value: "500" }] }));
    await call(ordersPaid.action, request());
    expect((await member("555")).pointsBalance).toBe(1000 + 100 - 433);
  });

  test("deducts for a loyalty discount even when no request reached the order", async () => {
    await makeCustomer({ shopifyCustomerId: "555", pointsBalance: 1000 });
    webhookContext("ORDERS_PAID", order(loyaltyDiscount("2.50", "Loyalty points redemption")));
    await call(ordersPaid.action, request());
    expect((await ledger()).find((t) => t.type === "REDEEM")?.points).toBe(-250);
  });

  test("recognises the discount by its current (renamed) title", async () => {
    await makeSettings({ discountAutomaticId: "gid://shopify/DiscountAutomaticNode/1" });
    await makeCustomer({ shopifyCustomerId: "555", pointsBalance: 1000 });
    shopify.admin.on("RedemptionDiscountTitle", () => ({ data: { discountNode: { discount: { title: "Rewards" } } } }));
    webhookContext("ORDERS_PAID", order(loyaltyDiscount("1.00", "Rewards")));
    await call(ordersPaid.action, request());
    expect((await ledger()).find((t) => t.type === "REDEEM")?.points).toBe(-100);
  });

  test("deducts nothing when points were requested but no loyalty discount applied", async () => {
    await makeCustomer({ shopifyCustomerId: "555", pointsBalance: 1000 });
    for (const [id, extra] of [
      [1, {}],
      [2, { discount_applications: [{ type: "automatic", title: "Summer sale", value: "5" }] }],
    ] as const) {
      webhookContext("ORDERS_PAID", order({ id, ...extra, note_attributes: [{ key: "points_to_redeem", value: "500" }] }));
      await call(ordersPaid.action, request());
    }
    webhookContext("ORDERS_PAID", order({ id: 3, discount_applications: [{ type: "automatic", title: "Summer sale", value: "5" }] }));
    await call(ordersPaid.action, request());
    expect((await ledger()).some((t) => t.type === "REDEEM")).toBe(false);
  });

  test("applies a referral code from the cart attributes", async () => {
    await makeCustomer({ shopifyCustomerId: "owner" });
    await createReferralCode(shop, "owner", { code: "FRIEND", createdByMerchant: true });
    webhookContext("ORDERS_PAID", order({ note_attributes: [{ name: "referral_code", value: "friend" }] }));
    await call(ordersPaid.action, request());
    expect((await member("owner")).pointsBalance).toBe(500);
    expect((await member("555")).pointsBalance).toBe(350);
    expect((await member("owner")).syncedPointsBalance).toBe(500);
  });

  test("an invalid referral code doesn't fail the webhook", async () => {
    webhookContext("ORDERS_PAID", order({ note_attributes: [{ name: "referral_code", value: "NOPE" }] }));
    expect((await call(ordersPaid.action, request())).value.status).toBe(200);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("referral code NOPE not applied"));
  });

  test("an unexpected referral failure fails the webhook so Shopify retries", async () => {
    await makeCustomer({ shopifyCustomerId: "owner" });
    await createReferralCode(shop, "owner", { code: "FRIEND", createdByMerchant: true });
    webhookContext("ORDERS_PAID", order({ note_attributes: [{ name: "referral_code", value: "FRIEND" }] }));
    await withFailingWrites("ReferralCode", "UPDATE", async () => {
      await expect(call(ordersPaid.action, request())).rejects.toThrow("simulated database failure");
    });
    // Points were awarded before the failure; the redelivery finishes the job.
    await call(ordersPaid.action, request());
    expect((await member("owner")).pointsBalance).toBe(500);
  });

  test("a redelivered order changes nothing", async () => {
    webhookContext("ORDERS_PAID", order());
    await call(ordersPaid.action, request());
    await call(ordersPaid.action, request());
    expect((await member("555")).pointsBalance).toBe(100);
  });
});

describe("refunds/create", () => {
  function subtotals(original: string, current: string) {
    shopify.admin.on("OrderSubtotals", () => ({
      data: { order: { subtotalPriceSet: { shopMoney: { amount: original } }, currentSubtotalPriceSet: { shopMoney: { amount: current } } } },
    }));
  }

  async function paid() {
    webhookContext("ORDERS_PAID", order());
    await call(ordersPaid.action, request());
  }

  test("claws back points in proportion to the subtotal refunded so far", async () => {
    await paid();
    subtotals("100.00", "60.00");
    webhookContext("REFUNDS_CREATE", { order_id: 1001 });
    await call(refundsCreate.action, request());
    expect((await member("555")).pointsBalance).toBe(60);
    expect((await member("555")).syncedPointsBalance).toBe(60);
  });

  test("an amount-only refund (subtotal unchanged) leaves points alone", async () => {
    await paid();
    subtotals("100.00", "100.00");
    webhookContext("REFUNDS_CREATE", { order_id: 1001 });
    await call(refundsCreate.action, request());
    expect((await member("555")).pointsBalance).toBe(100);
  });

  test("retries a network blip, and fails (for Shopify to redeliver) if Shopify stays down", async () => {
    await paid();
    let failures = 1;
    shopify.admin.on("OrderSubtotals", () =>
      failures-- > 0
        ? networkError()
        : { data: { order: { subtotalPriceSet: { shopMoney: { amount: "100" } }, currentSubtotalPriceSet: { shopMoney: { amount: "0" } } } } },
    );
    webhookContext("REFUNDS_CREATE", { order_id: 1001 });
    await call(refundsCreate.action, request());
    expect((await member("555")).pointsBalance).toBe(0);

    shopify.admin.on("OrderSubtotals", () => networkError());
    await expect(call(refundsCreate.action, request())).rejects.toThrow("fetch failed");
  });

  test("ignores refunds without an order, a session, or an order Shopify can't find", async () => {
    webhookContext("REFUNDS_CREATE", {});
    expect((await call(refundsCreate.action, request())).value.status).toBe(200);
    webhookContext("REFUNDS_CREATE", { order_id: 1 }, { session: false });
    expect((await call(refundsCreate.action, request())).value.status).toBe(200);
    webhookContext("REFUNDS_CREATE", { order_id: 1 });
    shopify.admin.on("OrderSubtotals", () => ({ data: { order: null } }));
    expect((await call(refundsCreate.action, request())).value.status).toBe(200);
    shopify.admin.on("OrderSubtotals", () => ({ data: { order: { subtotalPriceSet: null, currentSubtotalPriceSet: null } } }));
    expect((await call(refundsCreate.action, request())).value.status).toBe(200);
  });
});

describe("app and privacy webhooks", () => {
  test("app/uninstalled deletes sessions and marks balances for re-sync", async () => {
    await makeSession(shop);
    await makeCustomer({ shopifyCustomerId: "1", pointsBalance: 5, syncedPointsBalance: 5 });
    webhookContext("APP_UNINSTALLED", {});
    await call(appUninstalled.action, request());
    expect(await prisma.session.count()).toBe(0);
    expect((await member("1")).syncedPointsBalance).toBeNull();
  });

  test("customers/redact scrubs the member's PII and queued notifications", async () => {
    await makeCustomer({ shopifyCustomerId: "555", email: "buyer@example.com", displayName: "Buyer", pointsBalance: 10 });
    await prisma.notificationOutbox.create({
      data: { shop, eventName: "x", customerEmail: "buyer@example.com", shopifyCustomerId: "555", uniqueKey: "k", properties: {} },
    });
    webhookContext("CUSTOMERS_REDACT", { customer: { id: 555 } });
    await call(customersRedact.action, request());
    const scrubbed = await member("555");
    expect(scrubbed.email).toBeNull();
    expect(scrubbed.displayName).toBeNull();
    expect(scrubbed.pointsBalance).toBe(10);
    expect(await prisma.notificationOutbox.count()).toBe(0);
  });

  test("customers/redact tolerates unknown customers and missing ids", async () => {
    webhookContext("CUSTOMERS_REDACT", { customer: { id: 1 } });
    expect((await call(customersRedact.action, request())).value.status).toBe(200);
    webhookContext("CUSTOMERS_REDACT", {});
    expect((await call(customersRedact.action, request())).value.status).toBe(200);
  });

  test("customers/data_request logs whether Habit holds data", async () => {
    await makeCustomer({ shopifyCustomerId: "555" });
    webhookContext("CUSTOMERS_DATA_REQUEST", { customer: { id: 555 } });
    await call(customersDataRequest.action, request());
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("found ledger data"));
    webhookContext("CUSTOMERS_DATA_REQUEST", { customer: { id: 1 } });
    await call(customersDataRequest.action, request());
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("no ledger data on file"));
    webhookContext("CUSTOMERS_DATA_REQUEST", {});
    expect((await call(customersDataRequest.action, request())).value.status).toBe(200);
  });

  test("shop/redact purges the shop, falling back to the payload's domain", async () => {
    await makeSettings();
    await makeCustomer();
    webhookContext("SHOP_REDACT", { shop_domain: shop });
    await call(shopRedact.action, request());
    expect(await prisma.customer.count()).toBe(0);

    await makeSettings({}, "other.myshopify.com");
    shopifyServerModule.authenticate.webhook.mockResolvedValue({ shop: "", topic: "SHOP_REDACT", payload: { shop_domain: "other.myshopify.com" } });
    await call(shopRedact.action, request());
    expect(await prisma.shopSettings.count()).toBe(0);

    shopifyServerModule.authenticate.webhook.mockResolvedValue({ shop: "", topic: "SHOP_REDACT", payload: {} });
    expect((await call(shopRedact.action, request())).value.status).toBe(200);
  });

  test("shop/redact reports and rethrows a failed purge", async () => {
    webhookContext("SHOP_REDACT", {});
    await makeCustomer();
    await prisma.pointTransaction.create({ data: { shop, customerId: (await prisma.customer.findFirstOrThrow()).id, type: "EARN", points: 1 } });
    await withFailingWrites("PointTransaction", "DELETE", async () => {
      await expect(call(shopRedact.action, request())).rejects.toThrow("simulated database failure");
    });
  });

  test("app_subscriptions/update remembers or clears the App Pricing grant", async () => {
    webhookContext("APP_SUBSCRIPTIONS_UPDATE", { app_subscription: { status: "ACTIVE", plan_handle: "standard" } });
    await call(subscriptionsUpdate.action, request());
    expect(await loadAppPricingGrant(shop)).not.toBeNull();
    webhookContext("APP_SUBSCRIPTIONS_UPDATE", { status: "cancelled" });
    await call(subscriptionsUpdate.action, request());
    expect(await loadAppPricingGrant(shop)).toBeNull();

    await rememberAppPricingGrant(shop, "standard");
    webhookContext("APP_SUBSCRIPTIONS_UPDATE", { status: "ACCEPTED" });
    await call(subscriptionsUpdate.action, request());
    webhookContext("APP_SUBSCRIPTIONS_UPDATE", {});
    await call(subscriptionsUpdate.action, request());
    expect(await loadAppPricingGrant(shop)).not.toBeNull();
    await getOrCreateShopSettings(shop);
  });

  test("app/scopes_update stores the newly granted scopes", async () => {
    await makeSession(shop, "read_orders");
    webhookContext("APP_SCOPES_UPDATE", { current: ["read_orders", "write_customers"] });
    await call(scopesUpdate.action, request());
    expect((await prisma.session.findFirstOrThrow()).scope).toBe("read_orders,write_customers");
    webhookContext("APP_SCOPES_UPDATE", { current: [] }, { session: false });
    expect((await call(scopesUpdate.action, request())).value.status).toBe(200);
  });
});
