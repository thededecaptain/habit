import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The theme app extension's scripts, run against Dawn's real cart markup
 * with the storefront endpoints faked. These are the regressions that broke
 * the cart on review: the cart-page Check out button living outside the
 * form, an empty template for guests, and duplicate widgets.
 */

type Json = Record<string, unknown>;
type Handler = (url: string, init?: RequestInit) => Json | Promise<Json>;

let routes: Record<string, Handler> = {};
let requests: { url: string; body?: string }[] = [];

function respond(url: string, init?: RequestInit) {
  requests.push({ url, body: init?.body ? String(init.body) : undefined });
  const path = url.split("?")[0]!;
  const handler = routes[path];
  if (!handler) return Promise.reject(new Error(`unexpected fetch ${url}`));
  return Promise.resolve(handler(url, init)).then((json) => new Response(JSON.stringify(json)));
}

function cart(overrides: Json = {}) {
  return { item_count: 1, total_price: 10000, attributes: {}, ...overrides };
}

const member = {
  loggedIn: true,
  pointsBalance: 1949,
  balanceValue: 19.49,
  redemptionRate: 100,
  minRedeemablePoints: 100,
  maxRedemptionPercent: 50,
  pointsPerDollar: 1,
  earnMultiplier: 1.5,
};

const REDEEM_TEMPLATE = `
  <template id="habit-redeem-template">
    <div class="habit-widget habit-widget--compact" hidden data-habit-redeem data-habit-injected data-proxy-url="/apps/habit">
      <div data-habit-loading><p>Checking your rewards…</p></div>
      <div data-habit-redeem-body hidden>
        <p data-habit-applied-line hidden></p>
        <span data-habit-balance>0</span><span data-habit-value hidden></span>
        <p data-habit-redeem-balance-text></p>
        <input type="number" data-habit-redeem-input>
        <p data-habit-redeem-details hidden></p>
        <p data-habit-redeem-preview hidden></p>
        <button type="button" data-habit-redeem-apply>Apply points</button>
        <button type="button" data-habit-redeem-remove hidden>Remove</button>
        <p data-habit-redeem-status></p>
      </div>
    </div>
  </template>`;

const GUEST_REDEEM_TEMPLATE = `<template id="habit-redeem-template">\n  \n</template>`;

const REFERRAL_TEMPLATE = `
  <template id="habit-referral-template">
    <div class="habit-widget habit-referral" data-habit-referral data-proxy-url="/apps/habit">
      <details data-habit-referral-details>
        <summary>Have a referral code?</summary>
        <input type="text" data-habit-referral-input>
        <button type="button" data-habit-referral-apply>Apply code</button>
        <button type="button" data-habit-referral-remove hidden>Remove</button>
        <p data-habit-referral-status></p>
      </details>
    </div>
  </template>`;

/** Dawn's cart page: the Check out button sits outside the form (form="cart"). */
const DAWN_CART_PAGE = `
  <form action="/cart" id="cart"></form>
  <div class="cart__footer"><div class="cart__blocks">
    <div class="cart__ctas"><button type="submit" id="checkout" name="checkout" form="cart">Check out</button></div>
  </div></div>`;

const DAWN_CART_DRAWER = `
  <cart-drawer><div class="drawer__footer">
    <button type="submit" id="CartDrawer-Checkout" name="checkout" form="CartDrawer-Form">Check out</button>
  </div></cart-drawer>`;

type Script = "redeem-points" | "referral-code" | "points-widget";

/** Runs a theme script (a plain IIFE) in the page, like a <script> tag. */
async function runScript(name: Script) {
  await import(`../../extensions/points-widget/assets/${name}.js`);
}

async function loadScripts(...names: Script[]) {
  vi.resetModules();
  for (const name of names) await runScript(name);
}

async function settle() {
  await vi.advanceTimersByTimeAsync(200);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(10);
}

beforeEach(() => {
  vi.useFakeTimers();
  routes = {};
  requests = [];
  vi.stubGlobal("fetch", vi.fn(respond));
  document.body.innerHTML = "";
  const w = window as unknown as Json;
  delete w.__habitRedeemLoaded;
  delete w.__habitRedeemRefresh;
  delete w.HabitReferral;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function widgets(selector: string) {
  return [...document.querySelectorAll(selector)] as HTMLElement[];
}

describe("cart redeem widget (redeem-points.js)", () => {
  test("injects above Dawn's cart-page Check out button and shows the member's balance", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    await loadScripts("redeem-points");
    await settle();
    const widget = widgets("[data-habit-redeem]")[0]!;
    expect(widget.nextElementSibling?.classList.contains("cart__ctas")).toBe(true);
    expect(widget.hidden).toBe(false);
    expect(widget.querySelector("[data-habit-balance]")!.textContent).toBe("1,949");
    expect(widget.querySelector("[data-habit-value]")!.textContent).toBe("· $19.49");
    // 50% of $100 = $50 = 5000 points, capped by the 1,949 balance.
    expect(widget.querySelector("[data-habit-redeem-details]")!.textContent).toBe("Up to 1,949 points ($19.49).");
  });

  test("applies points to the cart attribute, updates, and removes them", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    routes["/cart/update.js"] = (_url, init) => cart({ attributes: JSON.parse(String(init?.body)).attributes });
    await loadScripts("redeem-points");
    await settle();
    const widget = widgets("[data-habit-redeem]")[0]!;
    const input = widget.querySelector("[data-habit-redeem-input]") as HTMLInputElement;
    input.value = "433";
    input.dispatchEvent(new Event("input"));
    expect(widget.querySelector("[data-habit-redeem-preview]")!.textContent).toBe("You'll save $4.33 at checkout");
    (widget.querySelector("[data-habit-redeem-apply]") as HTMLButtonElement).click();
    await settle();
    expect(JSON.parse(requests.find((r) => r.url === "/cart/update.js")!.body!)).toEqual({ attributes: { points_to_redeem: "433" } });
    expect(widget.querySelector("[data-habit-applied-line]")!.textContent).toBe("Applied · 433 points ($4.33 off at checkout)");
    expect(widget.querySelector("[data-habit-redeem-apply]")!.textContent).toBe("Update points");

    input.value = "99999";
    (widget.querySelector("[data-habit-redeem-apply]") as HTMLButtonElement).click();
    await settle();
    expect(JSON.parse(requests.filter((r) => r.url === "/cart/update.js").at(-1)!.body!).attributes.points_to_redeem).toBe("1949");

    (widget.querySelector("[data-habit-redeem-remove]") as HTMLButtonElement).click();
    await settle();
    expect(JSON.parse(requests.filter((r) => r.url === "/cart/update.js").at(-1)!.body!).attributes.points_to_redeem).toBe("0");
    expect(widget.querySelector("[data-habit-redeem-status]")!.textContent).toBe("Redemption removed.");
  });

  test("a failed cart update says so and re-enables the controls", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    routes["/cart/update.js"] = () => Promise.reject(new Error("offline"));
    await loadScripts("redeem-points");
    await settle();
    const widget = widgets("[data-habit-redeem]")[0]!;
    (widget.querySelector("[data-habit-redeem-apply]") as HTMLButtonElement).click();
    await settle();
    expect(widget.querySelector("[data-habit-redeem-status]")!.textContent).toBe("Couldn't update cart — try again.");
    expect((widget.querySelector("[data-habit-redeem-apply]") as HTMLButtonElement).disabled).toBe(false);
  });

  test("stays hidden for members without enough points, and for guests", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => ({ ...member, pointsBalance: 20, balanceValue: 0.2 });
    await loadScripts("redeem-points");
    await settle();
    expect(widgets("[data-habit-redeem]")[0]!.hidden).toBe(true);

    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    delete (window as unknown as Json).__habitRedeemLoaded;
    routes["/apps/habit/balance"] = () => ({ loggedIn: false });
    await loadScripts("redeem-points");
    await settle();
    expect(widgets("[data-habit-redeem]")[0]!.hidden).toBe(true);
  });

  test("a balance lookup failure shows a message instead of breaking the cart", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => Promise.reject(new Error("offline"));
    await loadScripts("redeem-points");
    await settle();
    expect(document.querySelector("[data-habit-loading]")!.textContent).toBe("Couldn't load rewards.");
  });

  test("doesn't inject into an empty cart, or twice", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart({ item_count: 0 });
    await loadScripts("redeem-points");
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(0);

    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    (window as unknown as { __habitRedeemRefresh: () => void }).__habitRedeemRefresh();
    await settle();
    (window as unknown as { __habitRedeemRefresh: () => void }).__habitRedeemRefresh();
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(1);
  });

  test("steps aside when the merchant placed the Redeem points block", async () => {
    document.body.innerHTML =
      `<div class="habit-widget" data-habit-redeem data-proxy-url="/apps/habit" data-cart-subtotal-cents="10000" data-applied-points="433">
         <div data-habit-loading></div><div data-habit-redeem-body hidden>
           <p data-habit-applied-line hidden></p><span data-habit-balance></span><span data-habit-value hidden></span>
           <p data-habit-redeem-balance-text></p><input data-habit-redeem-input><p data-habit-redeem-details hidden></p>
           <p data-habit-redeem-preview hidden></p><button data-habit-redeem-apply></button><button data-habit-redeem-remove hidden></button>
           <p data-habit-redeem-status></p></div></div>` + DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    await loadScripts("redeem-points");
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(1);
    expect(document.querySelector("[data-habit-applied-line]")!.textContent).toContain("Applied · 433 points");
  });

  test("injects into a cart drawer and re-checks when the cart changes", async () => {
    document.body.innerHTML = REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    routes["/cart/add.js"] = () => ({});
    await loadScripts("redeem-points");
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(0);

    // The theme opens its drawer after an add-to-cart.
    const holder = document.createElement("div");
    holder.innerHTML = DAWN_CART_DRAWER;
    document.body.appendChild(holder.firstElementChild!);
    await window.fetch("/cart/add.js", { method: "POST" });
    await settle();
    expect(widgets("cart-drawer [data-habit-redeem]")).toHaveLength(1);

    // Clicking the cart icon also triggers a check.
    const icon = document.createElement("a");
    icon.setAttribute("href", "/cart");
    document.body.appendChild(icon);
    icon.click();
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(1);
  });

  test("loading twice is harmless; waits for the DOM when still loading", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REDEEM_TEMPLATE;
    routes["/cart.js"] = () => cart();
    routes["/apps/habit/balance"] = () => member;
    const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    await loadScripts("redeem-points");
    readyState.mockRestore();
    await loadScripts("redeem-points");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await settle();
    expect(widgets("[data-habit-redeem]")).toHaveLength(1);
  });
});

describe("cart referral field (referral-code.js)", () => {
  async function setup(cartOverrides: Json = {}, redeemTemplate = GUEST_REDEEM_TEMPLATE) {
    document.body.innerHTML = DAWN_CART_PAGE + redeemTemplate + REFERRAL_TEMPLATE;
    routes["/cart.js"] = () => cart(cartOverrides);
    routes["/apps/habit/balance"] = () => member;
    routes["/cart/update.js"] = (_url, init) => cart({ attributes: JSON.parse(String(init?.body)).attributes });
    await loadScripts("redeem-points", "referral-code");
    await settle();
    return widgets("[data-habit-referral]")[0]!;
  }

  test("shows for a guest even though the redeem template is empty", async () => {
    const field = await setup();
    expect(field).toBeTruthy();
    expect(field.nextElementSibling?.classList.contains("cart__ctas")).toBe(true);
  });

  test("checks the code with the server, then saves it to the cart", async () => {
    const field = await setup({}, REDEEM_TEMPLATE);
    routes["/apps/habit/referral-check"] = () => ({ valid: true, code: "FRIEND10", refereeBonusPoints: 250 });
    const input = field.querySelector("[data-habit-referral-input]") as HTMLInputElement;
    input.value = " friend10 ";
    (field.querySelector("[data-habit-referral-apply]") as HTMLButtonElement).click();
    await settle();
    expect(requests.some((r) => r.url === "/apps/habit/referral-check?code=FRIEND10")).toBe(true);
    expect(JSON.parse(requests.find((r) => r.url === "/cart/update.js")!.body!)).toEqual({ attributes: { referral_code: "FRIEND10" } });
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe(
      "Code FRIEND10 applied. You'll get 250 bonus points after your order.",
    );
    expect((field.querySelector("[data-habit-referral-remove]") as HTMLElement).hidden).toBe(false);
    expect(field.querySelector("[data-habit-referral-apply]")!.textContent).toBe("Update code");
  });

  test("shows the server's reason when a code can't be used", async () => {
    const field = await setup();
    routes["/apps/habit/referral-check"] = () => ({ valid: false, error: "That referral code doesn't exist." });
    (field.querySelector("[data-habit-referral-input]") as HTMLInputElement).value = "NOPE";
    (field.querySelector("[data-habit-referral-apply]") as HTMLButtonElement).click();
    await settle();
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("That referral code doesn't exist.");
    expect(requests.some((r) => r.url === "/cart/update.js")).toBe(false);

    routes["/apps/habit/referral-check"] = () => ({ valid: false });
    (field.querySelector("[data-habit-referral-apply]") as HTMLButtonElement).click();
    await settle();
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("That code can't be used.");
  });

  test("asks for a code when the field is empty; reports network failures", async () => {
    const field = await setup();
    (field.querySelector("[data-habit-referral-apply]") as HTMLButtonElement).click();
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("Enter a referral code.");
    routes["/apps/habit/referral-check"] = () => Promise.reject(new Error("offline"));
    (field.querySelector("[data-habit-referral-input]") as HTMLInputElement).value = "X1234";
    (field.querySelector("[data-habit-referral-apply]") as HTMLButtonElement).click();
    await settle();
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("Couldn't apply the code — try again.");
  });

  test("a code already on the cart shows as applied and can be removed", async () => {
    const field = await setup({ attributes: { referral_code: "FRIEND10" } });
    expect((field.querySelector("[data-habit-referral-details]") as HTMLDetailsElement).open).toBe(true);
    expect((field.querySelector("[data-habit-referral-input]") as HTMLInputElement).value).toBe("FRIEND10");
    (field.querySelector("[data-habit-referral-remove]") as HTMLButtonElement).click();
    await settle();
    expect(JSON.parse(requests.find((r) => r.url === "/cart/update.js")!.body!)).toEqual({ attributes: { referral_code: "" } });
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("Referral code removed.");

    routes["/cart/update.js"] = () => Promise.reject(new Error("offline"));
    (field.querySelector("[data-habit-referral-remove]") as HTMLButtonElement).click();
    await settle();
    expect(field.querySelector("[data-habit-referral-status]")!.textContent).toBe("Couldn't update cart — try again.");
  });

  test("injects into a cart drawer; loads in either order; only once", async () => {
    document.body.innerHTML = DAWN_CART_DRAWER + GUEST_REDEEM_TEMPLATE + REFERRAL_TEMPLATE;
    routes["/cart.js"] = () => cart();
    vi.resetModules();
    await runScript("referral-code");
    vi.resetModules();
    await runScript("referral-code"); // a second copy on the page is a no-op
    await runScript("redeem-points");
    await settle();
    (window as unknown as { __habitRedeemRefresh: () => void }).__habitRedeemRefresh();
    await settle();
    expect(widgets("cart-drawer [data-habit-referral]")).toHaveLength(1);
  });

  test("does nothing without its template or for an empty cart", async () => {
    document.body.innerHTML = DAWN_CART_PAGE + REFERRAL_TEMPLATE;
    routes["/cart.js"] = () => cart({ item_count: 0 });
    await loadScripts("redeem-points", "referral-code");
    await settle();
    expect(widgets("[data-habit-referral]")).toHaveLength(0);
    const { HabitReferral } = window as unknown as { HabitReferral: { inject: (b: unknown, c: unknown) => void } };
    document.getElementById("habit-referral-template")!.remove();
    HabitReferral.inject(document.getElementById("checkout"), cart());
    HabitReferral.inject(null, cart());
    expect(widgets("[data-habit-referral]")).toHaveLength(0);
  });
});

describe("product widget (points-widget.js)", () => {
  const WIDGET = `
    <div class="habit-widget" data-habit-widget data-proxy-url="/apps/habit" data-product-price-cents="4999">
      <div data-habit-loading><p>Loading…</p></div>
      <div data-habit-loggedin hidden>
        <span data-habit-balance>0</span><span data-habit-value hidden></span>
        <p data-habit-context hidden></p><p data-habit-tier hidden></p><p data-habit-next-tier hidden></p>
        <p data-habit-expiry hidden></p><a data-habit-cart-link></a>
        <code data-habit-referral-code>—</code>
        <button data-habit-get-code>Get my code</button><button data-habit-copy-code hidden>Copy code</button>
        <p data-habit-referral-status></p>
      </div>
      <div data-habit-guest hidden><p data-habit-guest-context></p></div>
    </div>`;

  test("shows a member's balance, tier, progress, expiry, and earn estimate", async () => {
    document.body.innerHTML = WIDGET;
    routes["/apps/habit/balance"] = () => ({
      ...member,
      tierName: "Gold",
      nextTierName: "Platinum",
      nextTierRemainingSpend: 120,
      nextTierRemainingOrders: 1,
      expiresInDays: 1,
      referralCode: "MYCODE",
    });
    await loadScripts("points-widget");
    await settle();
    const text = (sel: string) => document.querySelector(sel)!.textContent;
    expect(text("[data-habit-balance]")).toBe("1,949");
    expect(text("[data-habit-context]")).toBe("This product would earn 74 points.");
    expect(text("[data-habit-tier]")).toBe("Gold tier");
    expect(text("[data-habit-next-tier]")).toBe("Spend $120.00 more and place 1 more order to reach Platinum");
    expect(text("[data-habit-expiry]")).toBe("Your points expire in 1 day.");
    expect(text("[data-habit-referral-code]")).toBe("MYCODE");
    expect((document.querySelector("[data-habit-cart-link]") as HTMLElement).hidden).toBe(false);

    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    (document.querySelector("[data-habit-copy-code]") as HTMLButtonElement).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("MYCODE");
    expect(text("[data-habit-referral-status]")).toBe("Copied");
  });

  test("gets a referral code on request and shows errors", async () => {
    document.body.innerHTML = WIDGET;
    routes["/apps/habit/balance"] = () => ({ ...member, pointsBalance: 10, expiresInDays: 12, nextTierName: "Gold", nextTierRemainingSpend: 0, nextTierRemainingOrders: 3 });
    routes["/apps/habit/referral-code"] = () => ({ code: "NEWCODE" });
    await loadScripts("points-widget");
    await settle();
    expect(document.querySelector("[data-habit-expiry]")!.textContent).toBe("Your points expire in 12 days.");
    expect(document.querySelector("[data-habit-next-tier]")!.textContent).toBe("place 3 more orders to reach Gold");
    expect((document.querySelector("[data-habit-cart-link]") as HTMLElement).hidden).toBe(true);
    (document.querySelector("[data-habit-get-code]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("[data-habit-referral-code]")!.textContent).toBe("NEWCODE");

    routes["/apps/habit/referral-code"] = () => ({ error: "You can have at most 5 active referral codes at a time." });
    (document.querySelector("[data-habit-get-code]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("[data-habit-referral-status]")!.textContent).toContain("at most 5");
    routes["/apps/habit/referral-code"] = () => Promise.reject(new Error("offline"));
    (document.querySelector("[data-habit-get-code]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("[data-habit-referral-status]")!.textContent).toBe("Something went wrong. Try again later.");
  });

  test("guests see the earn rate; failures show a message", async () => {
    document.body.innerHTML = WIDGET;
    routes["/apps/habit/balance"] = () => ({ loggedIn: false, pointsPerDollar: 2 });
    await loadScripts("points-widget");
    await settle();
    expect(document.querySelector("[data-habit-guest-context]")!.textContent).toBe("Earn ~99 points on this product. Earn 2 points per $1 spent.");

    document.body.innerHTML = WIDGET;
    routes["/apps/habit/balance"] = () => Promise.reject(new Error("offline"));
    await loadScripts("points-widget");
    await settle();
    expect(document.querySelector("[data-habit-loading]")!.textContent).toBe("Couldn't load your rewards right now.");
  });

  test("a member with no tier progress, earn estimate, or expiry shows just the balance", async () => {
    document.body.innerHTML = WIDGET.replace('data-product-price-cents="4999"', 'data-product-price-cents="0"');
    routes["/apps/habit/balance"] = () => ({ loggedIn: true, pointsBalance: 0, redemptionRate: 0, pointsPerDollar: 0, expiresInDays: null, nextTierName: "Gold", nextTierRemainingSpend: 0, nextTierRemainingOrders: 0 });
    await loadScripts("points-widget");
    await settle();
    expect((document.querySelector("[data-habit-context]") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[data-habit-next-tier]") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[data-habit-expiry]") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[data-habit-value]") as HTMLElement).hidden).toBe(true);
  });
});
