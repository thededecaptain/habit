import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The checkout (Plus) block, the Thank you block, and the customer-account
 * blocks, rendered with Preact against a fake `shopify` global. The checkout
 * block's writes must be cart attributes: those reach the order, cart
 * metafields didn't (the reviewer's referral codes vanished that way).
 */

vi.mock("@shopify/ui-extensions/preact", () => ({}));



// Fake extension globals and API payloads are loosely shaped on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const APP = "https://habit-production-9257.up.railway.app";
let responses: Record<string, (init?: RequestInit) => Json | Promise<Json> | Response> = {};
let attributes: { key: string; value: string }[] = [];

function fakeShopify(overrides: Json = {}) {
  const shopify: Json = {
    extension: {},
    instructions: { value: { attributes: { canUpdateAttributes: true } } },
    buyerIdentity: { customer: { value: { id: "gid://shopify/Customer/9" } } },
    cost: { subtotalAmount: { value: { amount: 100 } }, totalAmount: { value: { amount: 118 } } },
    attributes: { get value() { return attributes; } },
    applyAttributeChange: vi.fn(async (change: Json) => {
      attributes = attributes.filter((a) => a.key !== change.key);
      if (change.type === "updateAttribute") attributes.push({ key: change.key, value: change.value });
      return { type: "success" };
    }),
    sessionToken: { get: vi.fn(async () => "token") },
    ...overrides,
  };
  vi.stubGlobal("shopify", shopify);
  return shopify;
}

async function mount(path: string) {
  vi.resetModules();
  const mod = await import(path);
  await mod.default();
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function text() {
  return document.body.textContent ?? "";
}

function button(label: string) {
  const match = [...document.querySelectorAll("s-button")].find((b) => b.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}" in: ${text()}`);
  return match as HTMLElement;
}

function field(selector: string, value: string) {
  const el = document.querySelector(selector) as HTMLElement & { value?: string };
  if (!el) throw new Error(`No ${selector}`);
  el.value = value;
  el.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  // Preact runs effects after the next animation frame (or a 100ms
  // fallback); jsdom never paints, so make frames fire on the next tick.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  responses = {};
  attributes = [];
  document.body.innerHTML = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(APP, "").split("?")[0]!;
      const handler = responses[path];
      if (!handler) throw new Error(`unexpected fetch ${url}`);
      const result = await handler(init);
      return result instanceof Response ? result : new Response(JSON.stringify(result));
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const member = { loggedIn: true, pointsBalance: 1949, balanceValue: 19.49, redemptionRate: 100, minRedeemablePoints: 100, maxRedemptionPercent: 50, pointsPerDollar: 1, earnMultiplier: 1 };

describe("checkout block (Checkout.jsx)", () => {
  const CHECKOUT = "../../extensions/redeem-points/src/Checkout.jsx";

  test("a signed-in member applies points as a cart attribute, capped at 50% of the subtotal", async () => {
    const shopify = fakeShopify();
    responses["/checkout-api/points"] = () => member;
    await mount(CHECKOUT);
    expect(text()).toContain("1,949 points · $19.49 to spend");
    expect(text()).toContain("Up to 1,949 points ($19.49).");
    field("s-number-field", "433");
    await settle();
    expect(text()).toContain("You’ll save $4.33");
    button("Apply points").click();
    await settle();
    expect(shopify.applyAttributeChange).toHaveBeenCalledWith({ type: "updateAttribute", key: "points_to_redeem", value: "433" });

    field("s-number-field", "99999");
    await settle();
    expect(text()).toContain("You’ll save $19.49"); // the preview never promises more than applies
    button("Update points").click();
    await settle();
    expect(shopify.applyAttributeChange).toHaveBeenLastCalledWith({ type: "updateAttribute", key: "points_to_redeem", value: "1949" });
  });

  test("applying 0 removes the attribute; an existing attribute shows as applied", async () => {
    attributes = [{ key: "points_to_redeem", value: "200" }];
    const shopify = fakeShopify();
    responses["/checkout-api/points"] = () => member;
    await mount(CHECKOUT);
    expect(text()).toContain("Applied · 200 points ($2.00 off)");
    field("s-number-field", "");
    await settle();
    button("Update points").click();
    await settle();
    expect(shopify.applyAttributeChange).toHaveBeenCalledWith({ type: "removeAttribute", key: "points_to_redeem" });
  });

  test("the cap comes from the subtotal when the balance is larger", async () => {
    fakeShopify({ cost: { subtotalAmount: { value: { amount: 20 } } } });
    responses["/checkout-api/points"] = () => ({ ...member, pointsBalance: 5000, balanceValue: 50 });
    await mount(CHECKOUT);
    expect(text()).toContain("Up to 1,000 points ($10.00).");
  });

  test("checks a referral code with the server before saving it as an attribute", async () => {
    const shopify = fakeShopify();
    responses["/checkout-api/points"] = () => member;
    responses["/checkout-api/referral-check"] = () => ({ valid: true, code: "FRIEND10", refereeBonusPoints: 250 });
    await mount(CHECKOUT);
    field('s-text-field[label="Referral code"]', " friend10 ");
    await settle();
    button("Apply code").click();
    await settle();
    expect(shopify.applyAttributeChange).toHaveBeenCalledWith({ type: "updateAttribute", key: "referral_code", value: "FRIEND10" });
    expect(text()).toContain("Code FRIEND10 applied. You'll get 250 bonus points after your order.");
  });

  test("a rejected code shows the reason and saves nothing", async () => {
    const shopify = fakeShopify();
    responses["/checkout-api/points"] = () => member;
    responses["/checkout-api/referral-check"] = () => ({ valid: false, error: "Referral codes are for a customer's first order." });
    await mount(CHECKOUT);
    field('s-text-field[label="Referral code"]', "FRIEND10");
    await settle();
    button("Apply code").click();
    await settle();
    expect(text()).toContain("Referral codes are for a customer's first order.");
    expect(shopify.applyAttributeChange).not.toHaveBeenCalled();

    responses["/checkout-api/referral-check"] = () => ({ valid: false });
    button("Apply code").click();
    await settle();
    expect(text()).toContain("That code can't be used.");
  });

  test("referral: empty input does nothing; network and save failures are reported", async () => {
    const shopify = fakeShopify();
    responses["/checkout-api/points"] = () => member;
    await mount(CHECKOUT);
    button("Apply code").click();
    await settle();
    expect(shopify.sessionToken.get).toHaveBeenCalledTimes(1);

    field('s-text-field[label="Referral code"]', "FRIEND10");
    await settle();
    responses["/checkout-api/referral-check"] = () => Promise.reject(new Error("offline"));
    button("Apply code").click();
    await settle();
    expect(text()).toContain("Couldn't check the code — try again.");

    responses["/checkout-api/referral-check"] = () => ({ valid: true, code: "FRIEND10", refereeBonusPoints: 0 });
    shopify.applyAttributeChange.mockResolvedValueOnce({ type: "error", message: "nope" });
    button("Apply code").click();
    await settle();
    expect(text()).toContain("Couldn't save the code — try again.");
  });

  test("guests see program info and the referral field", async () => {
    fakeShopify({ buyerIdentity: { customer: { value: null } } });
    responses["/checkout-api/referral-check"] = () => ({ valid: true, code: "PAL", refereeBonusPoints: 250 });
    await mount(CHECKOUT);
    expect(text()).toContain("Sign in to see your points balance");
    field('s-text-field[label="Referral code"]', "pal");
    await settle();
    button("Apply code").click();
    await settle();
    expect(text()).toContain("Code PAL applied.");
  });

  test("a failed balance load shows a reassuring warning", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => Promise.reject(new Error("offline"));
    await mount(CHECKOUT);
    expect(text()).toContain("We couldn't load your points balance right now.");
  });

  test("members below the minimum, or whose order can't take points, see why", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => ({ ...member, pointsBalance: 0, balanceValue: 0 });
    await mount(CHECKOUT);
    expect(text()).toContain("You don't have points to redeem yet.");

    document.body.innerHTML = "";
    fakeShopify();
    responses["/checkout-api/points"] = () => ({ ...member, pointsBalance: 50, balanceValue: undefined });
    await mount(CHECKOUT);
    expect(text()).toContain("You need at least 100 points to redeem.");
    expect(text()).toContain("$0.50 to spend");

    document.body.innerHTML = "";
    fakeShopify({ cost: { subtotalAmount: { value: { amount: 0 } } } });
    responses["/checkout-api/points"] = () => member;
    await mount(CHECKOUT);
    expect(text()).toContain("Points can't be applied to this order total right now.");
  });

  test("with no percent cap the balance is the limit", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => ({ ...member, maxRedemptionPercent: 0 });
    await mount(CHECKOUT);
    expect(text()).toContain("Up to 1,949 points");
  });

  test("controls are disabled where attributes can't be changed (e.g. Apple Pay)", async () => {
    const shopify = fakeShopify({ instructions: { value: { attributes: { canUpdateAttributes: false } } } });
    responses["/checkout-api/points"] = () => member;
    await mount(CHECKOUT);
    expect(button("Apply points").hasAttribute("disabled")).toBe(true);
    button("Apply points").click();
    field('s-text-field[label="Referral code"]', "X1234");
    await settle();
    button("Apply code").click();
    await settle();
    expect(shopify.applyAttributeChange).not.toHaveBeenCalled();
  });

  test("the checkout editor always shows a preview", async () => {
    fakeShopify({ extension: { editor: { type: "checkout" } }, buyerIdentity: { customer: { value: null } } });
    await mount(CHECKOUT);
    expect(text()).toContain("Preview — shown to logged-in customers with points.");
  });

  test("shows a spinner while loading", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => new Promise(() => {});
    await mount(CHECKOUT);
    expect(text()).toContain("Checking your rewards…");
  });
});

describe("Thank you block (ThankYou.jsx)", () => {
  const THANK_YOU = "../../extensions/redeem-points/src/ThankYou.jsx";

  test("estimates points from the subtotal (not the total with shipping and tax)", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => ({ ...member, earnMultiplier: 1.5 });
    await mount(THANK_YOU);
    expect(text()).toContain("You earned 150 points on this order.");
    expect(text()).toContain("Balance before this order: 1,949 points ($19.49 to spend).");
  });

  test("falls back to the total, and handles a zero rate or balance", async () => {
    fakeShopify({ cost: { totalAmount: { value: { amount: 40 } } } });
    responses["/checkout-api/points"] = () => ({ ...member, pointsBalance: 0, balanceValue: undefined });
    await mount(THANK_YOU);
    expect(text()).toContain("You earned 40 points");
    expect(text()).not.toContain("Balance before");

    document.body.innerHTML = "";
    fakeShopify({ cost: {} });
    responses["/checkout-api/points"] = () => ({ ...member, pointsPerDollar: 0, balanceValue: undefined, redemptionRate: 0 });
    await mount(THANK_YOU);
    expect(text()).toContain("Your points are on the way.");
  });

  test("guests are invited to create an account", async () => {
    fakeShopify({ buyerIdentity: {} });
    responses["/checkout-api/points"] = () => ({ loggedIn: false, pointsPerDollar: 1 });
    await mount(THANK_YOU);
    expect(text()).toContain("This order is worth 100 points.");
    expect(text()).toContain("Create an account with this email");

    document.body.innerHTML = "";
    fakeShopify({ buyerIdentity: {} });
    responses["/checkout-api/points"] = () => ({ loggedIn: false });
    await mount(THANK_YOU);
    expect(text()).not.toContain("This order is worth");
  });

  test("stays generic when the rates can't be loaded", async () => {
    fakeShopify();
    responses["/checkout-api/points"] = () => new Response("down", { status: 503 });
    await mount(THANK_YOU);
    expect(text()).toContain("Points from this order will appear in your account shortly.");
  });

  test("editor preview and loading state", async () => {
    fakeShopify({ extension: { editor: {} } });
    await mount(THANK_YOU);
    expect(text()).toContain("You earned 699 points on this order.");
    document.body.innerHTML = "";
    fakeShopify();
    responses["/checkout-api/points"] = () => new Promise(() => {});
    await mount(THANK_YOU);
    expect(text()).toContain("Checking your rewards…");
  });
});

describe("customer account blocks (Profile.jsx, Announcement.jsx)", () => {
  const PROFILE = "../../extensions/account-rewards/src/Profile.jsx";
  const ANNOUNCEMENT = "../../extensions/account-rewards/src/Announcement.jsx";

  test("the profile block shows balance, tier progress, expiry, history, and the referral code", async () => {
    fakeShopify();
    responses["/account-api/points"] = () => ({
      ...member,
      tierName: "Gold",
      nextTierName: "Platinum",
      nextTierRemainingSpend: 50,
      nextTierRemainingOrders: 2,
      expiresInDays: 5,
      referralCode: "MYCODE",
      history: [
        { type: "EARN", points: 100, description: "Earned on order", createdAt: "a" },
        { type: "REDEMPTION_REFUND", points: 40, description: null, createdAt: "b" },
        { type: "NEW_TYPE", points: -3, description: null, createdAt: "c" },
      ],
    });
    await mount(PROFILE);
    for (const expected of ["1,949 points", "$19.49 to spend", "Gold tier", "Spend $50.00 more and place 2 more orders to reach Platinum", "Your points expire in 5 days.", "+100", "Points returned", "NEW_TYPE", "MYCODE"]) {
      expect(text()).toContain(expected);
    }
  });

  test("the profile block gets a referral code on request", async () => {
    fakeShopify();
    responses["/account-api/points"] = (init) => (init?.method === "POST" ? { code: "NEWCODE" } : { ...member, balanceValue: undefined, expiresInDays: 1, nextTierName: "Gold", nextTierRemainingSpend: 0, nextTierRemainingOrders: 1 });
    await mount(PROFILE);
    expect(text()).toContain("No activity yet");
    expect(text()).toContain("Your points expire in 1 day.");
    expect(text()).toContain("place 1 more order to reach Gold");
    button("Get my code").click();
    await settle();
    expect(text()).toContain("NEWCODE");
  });

  test("the profile block reports referral errors and failures", async () => {
    fakeShopify();
    let post = 0;
    responses["/account-api/points"] = (init) => {
      if (init?.method !== "POST") return { ...member, nextTierName: "Gold", nextTierRemainingSpend: 0, nextTierRemainingOrders: 0 };
      post += 1;
      if (post === 1) return { error: "You can have at most 5 active referral codes at a time." };
      return Promise.reject(new Error("offline"));
    };
    await mount(PROFILE);
    button("Get my code").click();
    await settle();
    expect(text()).toContain("at most 5");
    button("Get my code").click();
    await settle();
    expect(text()).toContain("Couldn't get a code — try again.");
  });

  test("the profile block handles guests, failures, the editor, and loading", async () => {
    fakeShopify();
    responses["/account-api/points"] = () => ({ loggedIn: false });
    await mount(PROFILE);
    expect(text()).toContain("Sign in or create an account");

    document.body.innerHTML = "";
    fakeShopify();
    responses["/account-api/points"] = () => new Response("down", { status: 500 });
    await mount(PROFILE);
    expect(text()).toContain("Couldn't load your rewards right now.");

    document.body.innerHTML = "";
    fakeShopify({ extension: { editor: {} } });
    await mount(PROFILE);
    expect(text()).toContain("Preview — signed-in customers see their live balance here.");

    document.body.innerHTML = "";
    fakeShopify();
    responses["/account-api/points"] = () => new Promise(() => {});
    await mount(PROFILE);
    expect(text()).toContain("Loading your rewards…");
  });

  test("the orders-page announcement summarises the balance", async () => {
    fakeShopify();
    responses["/account-api/points"] = () => member;
    await mount(ANNOUNCEMENT);
    expect(text()).toContain("You have 1,949 Habit points ($19.49 to spend).");

    for (const [data, expected] of [
      [{ ...member, pointsBalance: 0, balanceValue: undefined, redemptionRate: 0 }, "Earn Habit points on every purchase"],
      [{ loggedIn: false }, "Sign in to see your Habit rewards balance."],
      [{ ...member, balanceValue: undefined }, "($19.49 to spend)"],
    ] as const) {
      document.body.innerHTML = "";
      fakeShopify();
      responses["/account-api/points"] = () => data;
      await mount(ANNOUNCEMENT);
      expect(text()).toContain(expected);
    }

    document.body.innerHTML = "";
    fakeShopify();
    responses["/account-api/points"] = () => new Response("down", { status: 500 });
    await mount(ANNOUNCEMENT);
    expect(text()).toContain("Habit rewards are available when you shop this store.");

    document.body.innerHTML = "";
    fakeShopify({ extension: { editor: {} } });
    await mount(ANNOUNCEMENT);
    expect(text()).toContain("Preview.");
  });
});
