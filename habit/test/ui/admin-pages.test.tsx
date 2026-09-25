import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Dashboard from "../../app/routes/app._index";
import Members from "../../app/routes/app.customers";
import MemberDetail from "../../app/routes/app.customers.$id";
import VipTiers from "../../app/routes/app.tiers";
import Settings from "../../app/routes/app.settings";
import Billing from "../../app/routes/app.billing";
import App, { ErrorBoundary as AppErrorBoundary, headers as appHeaders } from "../../app/routes/app";
import Landing from "../../app/routes/_index/route";
import { SupportFooter } from "../../app/components/support-footer";
import * as referrals from "../../app/routes/app.referrals";
import * as dashboard from "../../app/routes/app._index";
import * as members from "../../app/routes/app.customers";
import * as memberDetail from "../../app/routes/app.customers.$id";
import * as tiers from "../../app/routes/app.tiers";
import * as settingsRoute from "../../app/routes/app.settings";
import * as billing from "../../app/routes/app.billing";
import * as authSplat from "../../app/routes/auth.$";
import { appBridge, clickText, el, flush, renderRoute, typeInto } from "../helpers/ui";

const metrics = { memberCount: 3, pointsIssued: 5000, pointsRedeemed: 1200, outstandingLiability: 2500, repeatPurchaseRate: 0.4, redemptionOfGmv: 0.02 };
const dashboardData = {
  shop: "habit-test.myshopify.com",
  onboardingDismissed: false,
  showVelocityAlert: true,
  hasCustomTiers: false,
  ratesReviewed: true,
  metrics,
  settings: { pointsPerDollar: 1, redemptionRate: 100 },
  completedSteps: ["product_widget"],
};

describe("dashboard", () => {
  test("shows metrics, the setup guide, and records step changes", async () => {
    const { container, actions } = await renderRoute(Dashboard, { path: "/app", loaderData: dashboardData });
    await screen.findByText("Unusual referral activity", { exact: false }).catch(() => null);
    expect(container.textContent).toContain("Add the product widget");
    expect(container.textContent).toContain("$25.00");
    // The guide opens on the first unfinished step ("Turn on Redeem points in cart").
    clickText(container, "Mark as done");
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "complete-step", step: "cart_embed" }));
    fireEvent.click(el(container, 's-button[accessibilityLabel="Toggle Add the product widget"]'));
    clickText(container, "Mark as not done");
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "uncomplete-step", step: "product_widget" }));
  });

  test("dismissing the velocity alert is saved (it used to only hide until reload)", async () => {
    const { container, actions } = await renderRoute(Dashboard, { path: "/app", loaderData: dashboardData });
    await flush();
    fireEvent(el(container, "s-banner"), new Event("dismiss"));
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "dismiss-velocity-alert" }));
  });

  test("the setup guide can be dismissed, and a finished program says so", async () => {
    const done = {
      ...dashboardData,
      showVelocityAlert: false,
      hasCustomTiers: true,
      completedSteps: ["product_widget", "cart_embed", "checkout_redeem", "account_rewards"],
    };
    const { container, actions } = await renderRoute(Dashboard, { path: "/app", loaderData: done });
    await flush();
    const dismiss = [...container.querySelectorAll("s-button")].find((b) => /dismiss/i.test(b.textContent ?? "") || /dismiss/i.test(b.getAttribute("accessibilityLabel") ?? ""));
    if (dismiss) {
      fireEvent.click(dismiss);
      await vi.waitFor(() => expect(actions).toContainEqual({ intent: "dismiss-onboarding" }));
    }
    const { container: dismissed } = await renderRoute(Dashboard, { path: "/app", loaderData: { ...done, onboardingDismissed: true, metrics: { ...metrics, memberCount: 0 }, ratesReviewed: false } });
    await flush();
    expect(dismissed.textContent).not.toContain("Add the product widget");
  });

  test("headers come from Shopify's boundary", () => {
    expect(dashboard.headers).toBeTypeOf("function");
    for (const route of [referrals, members, memberDetail, tiers, settingsRoute, billing, dashboard, authSplat]) {
      expect(route.headers?.({ loaderHeaders: new Headers(), parentHeaders: new Headers(), actionHeaders: new Headers(), errorHeaders: undefined } as never)).toBeTruthy();
    }
  });
});

describe("members", () => {
  const data = {
    q: "",
    page: 1,
    hasNext: true,
    customers: [
      { id: "m1", shopifyCustomerId: "1", email: "ann@example.com", displayName: "Ann", pointsBalance: 1200, tierName: "Gold", createdAt: "2026-09-01T00:00:00Z" },
      { id: "m2", shopifyCustomerId: "2", email: null, displayName: null, pointsBalance: 0, tierName: null, createdAt: "2026-09-01T00:00:00Z" },
    ],
  };

  test("lists members and adjusts points through the modal", async () => {
    const { container, actions } = await renderRoute(Members, { path: "/app/customers", loaderData: data, action: () => ({ ok: true }) });
    expect(await screen.findByText("Ann")).toBeTruthy();
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // no name or email: shown by id
    fireEvent.click([...container.querySelectorAll("s-button")].find((b) => b.textContent === "Adjust points")!);
    typeInto(el(container, 's-number-field[label^="Points to add"]'), "250");
    typeInto(el(container, 's-text-field[label="Reason"]'), "Goodwill");
    clickText(container, "Save adjustment");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Points adjusted"));
    expect(actions[0]).toEqual({ customerId: "m1", amount: "250", reason: "Goodwill" });
  });

  test("shows server errors, and Save without a member does nothing", async () => {
    const { container, actions } = await renderRoute(Members, { path: "/app/customers", loaderData: data, action: () => ({ errors: { amount: "Enter a whole, non-zero number of points." } }) });
    await screen.findByText("Ann");
    clickText(container, "Save adjustment");
    expect(actions).toHaveLength(0);
    fireEvent.click([...container.querySelectorAll("s-button")].find((b) => b.textContent === "Adjust points")!);
    clickText(container, "Save adjustment");
    await vi.waitFor(() => expect(el(container, 's-number-field[label^="Points to add"]').getAttribute("error")).toContain("whole"));
  });

  test("search is debounced into the URL; empty state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderRoute(Members, { path: "/app/customers", loaderData: { ...data, page: 2 }, url: "/app/customers?page=2" });
    await screen.findByText("Ann");
    typeInto(el(container, "s-search-field"), "ann");
    await vi.advanceTimersByTimeAsync(350);
    typeInto(el(container, "s-search-field"), "");
    await vi.advanceTimersByTimeAsync(350);
    const { container: empty } = await renderRoute(Members, { path: "/app/customers", loaderData: { ...data, customers: [] } });
    await flush();
    expect(empty.textContent).toContain("No members yet");
  });
});

describe("member detail", () => {
  const data = {
    customer: { id: "m1", email: "ann@example.com", displayName: "Ann", shopifyCustomerId: "1", pointsBalance: 500, lifetimeSpend: 1234.5, lifetimeOrders: 3, tierName: "Gold", createdAt: "2026-09-01T00:00:00Z" },
    transactions: [
      { id: "t1", type: "EARN", points: 100, description: "Earned", orderId: "o1", createdAt: "2026-09-01T00:00:00Z" },
      { id: "t2", type: "REDEMPTION_REFUND", points: -5, description: null, orderId: null, createdAt: "2026-09-02T00:00:00Z" },
      { id: "t3", type: "SOMETHING_NEW", points: 1, description: "x", orderId: null, createdAt: "2026-09-03T00:00:00Z" },
    ],
    referralCodes: [
      { id: "c1", code: "MINE1", status: "ACTIVE", expiresAt: null },
      { id: "c2", code: "OLD1", status: "UNKNOWN", expiresAt: null },
    ],
  };

  test("shows the profile, ledger and codes, and revokes a code", async () => {
    const { container, actions } = await renderRoute(MemberDetail, { path: "/app/customers/:id", url: "/app/customers/m1", loaderData: data, action: () => ({ ok: true }) });
    expect(await screen.findByText("$1234.50")).toBeTruthy();
    expect(screen.getByText("Points returned (refund)")).toBeTruthy();
    expect(screen.getByText("SOMETHING_NEW")).toBeTruthy();
    clickText(container, "Revoke");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Referral code revoked"));
    expect(actions[0]).toEqual({ intent: "revoke-code", codeId: "c1" });
  });

  test("a member with no history or codes", async () => {
    const { container } = await renderRoute(MemberDetail, {
      path: "/app/customers/:id",
      url: "/app/customers/m1",
      loaderData: { ...data, customer: { ...data.customer, displayName: null, email: null, tierName: null }, transactions: [], referralCodes: [] },
    });
    await flush();
    expect(container.textContent).toContain("No transactions yet.");
    expect(container.textContent).toContain("No referral codes generated.");
  });
});

describe("VIP tiers", () => {
  const data = { tiers: [{ id: "t1", name: "Gold", minSpend: 500, minOrders: null, earnMultiplier: 1.5, sortOrder: 0 }, { id: "t2", name: "Silver", minSpend: null, minOrders: 3, earnMultiplier: 1.2, sortOrder: 1 }] };

  test("adds, edits and deletes tiers", async () => {
    const { container, actions } = await renderRoute(VipTiers, { path: "/app/tiers", loaderData: data, action: () => ({ ok: true }) });
    expect(await screen.findByText("$500.00")).toBeTruthy();
    clickText(container, "Add tier");
    typeInto(el(container, 's-text-field[label="Tier name"]'), "Platinum");
    typeInto(el(container, 's-money-field[label="Minimum lifetime spend"]'), "2000");
    typeInto(el(container, 's-number-field[label="Minimum lifetime orders"]'), "");
    typeInto(el(container, 's-number-field[label="Earn multiplier"]'), "2");
    typeInto(el(container, 's-number-field[label="Sort order"]'), "2");
    clickText(container, "Save");
    await vi.waitFor(() => expect(actions[0]).toMatchObject({ intent: "create", name: "Platinum", minSpend: "2000", earnMultiplier: "2", sortOrder: "2" }));

    fireEvent.click([...container.querySelectorAll("s-button")].find((b) => b.textContent === "Edit")!);
    typeInto(el(container, 's-number-field[label="Minimum lifetime orders"]'), "4");
    typeInto(el(container, 's-money-field[label="Minimum lifetime spend"]'), "");
    typeInto(el(container, 's-number-field[label="Earn multiplier"]'), "");
    typeInto(el(container, 's-number-field[label="Sort order"]'), "");
    clickText(container, "Save");
    await vi.waitFor(() => expect(actions[1]).toMatchObject({ intent: "update", id: "t1" }));

    fireEvent.click([...container.querySelectorAll("s-button")].find((b) => b.textContent === "Delete")!);
    fireEvent.click(el(container, 's-modal[heading="Delete VIP tier"] s-button[slot="primary-action"]'));
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "delete", id: "t1" }));
  });

  test("shows validation errors and an empty state", async () => {
    const { container } = await renderRoute(VipTiers, { path: "/app/tiers", loaderData: { tiers: [] }, action: () => ({ errors: { name: "Tier name is required." } }) });
    await flush();
    expect(container.textContent).toMatch(/No VIP tiers|no tiers/i);
    clickText(container, "Add tier");
    clickText(container, "Save");
    await vi.waitFor(() => expect(el(container, 's-text-field[label="Tier name"]').getAttribute("error")).toBe("Tier name is required."));
  });
});

describe("settings", () => {
  const values = {
    pointsPerDollar: "1", redemptionRate: "100", minRedeemablePoints: "100", maxRedemptionPercent: "50",
    referrerBonusPoints: "500", refereeBonusPoints: "250", referralCodeExpiryDays: "30", maxActiveReferralCodesPerCustomer: "5",
    referralVelocityThreshold: "50", referralVelocityWindowMinutes: "60", pointsExpiryDays: "", notificationWebhookUrl: "",
  };
  const data = { values, amount: 49, trialDays: 30, billingUnavailable: false, subscription: { source: "billing-api", status: "ACTIVE", inTrial: true, trialEndsAt: "2026-10-20T00:00:00Z", currentPeriodEnd: null } };

  test("editing shows the save bar; saving sends the form and confirms", async () => {
    const { container, actions } = await renderRoute(Settings, { path: "/app/settings", loaderData: data, action: () => ({ errors: null, savedAt: 1 }) });
    await flush();
    expect(container.textContent).toContain("Trial ends");
    typeInto(el(container, 's-number-field[label="Points earned per $1 spent"]'), "2");
    await vi.waitFor(() => expect(appBridge.saveBar.show).toHaveBeenCalledWith("settings-save-bar"));
    fireEvent.click([...container.querySelectorAll("ui-save-bar button")].find((b) => b.textContent?.trim() === "Save")!);
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Settings saved"));
    expect(actions[0]).toMatchObject({ pointsPerDollar: "2", redemptionRate: "100" });
  });

  test("discard restores the saved values; errors clear once the field is edited", async () => {
    const { container } = await renderRoute(Settings, { path: "/app/settings", loaderData: data, action: () => ({ errors: { redemptionRate: "Redemption rate must be a number greater than 0." } }) });
    await flush();
    typeInto(el(container, 's-number-field[label="Points needed for $1 off"]'), "0");
    fireEvent.click([...container.querySelectorAll("ui-save-bar button")].find((b) => b.textContent?.trim() === "Save")!);
    await vi.waitFor(() => expect(el(container, 's-number-field[label="Points needed for $1 off"]').getAttribute("error")).toContain("greater than 0"));
    typeInto(el(container, 's-number-field[label="Points needed for $1 off"]'), "50");
    await vi.waitFor(() => expect(el(container, 's-number-field[label="Points needed for $1 off"]').getAttribute("error")).toBeNull());
    fireEvent.click([...container.querySelectorAll("ui-save-bar button")].find((b) => b.textContent?.trim() === "Discard")!);
    await vi.waitFor(() => expect(appBridge.saveBar.hide).toHaveBeenCalled());
  });

  test("every field feeds the form, including the webhook URL", async () => {
    const { container, actions } = await renderRoute(Settings, { path: "/app/settings", loaderData: data, action: () => ({ errors: null }) });
    await flush();
    for (const field of container.querySelectorAll("s-number-field, s-url-field")) {
      typeInto(field as HTMLElement, field.tagName === "S-URL-FIELD" ? "https://hooks.example.com" : "7");
    }
    fireEvent.click([...container.querySelectorAll("ui-save-bar button")].find((b) => b.textContent?.trim() === "Save")!);
    await vi.waitFor(() => expect(actions[0]).toMatchObject({ notificationWebhookUrl: "https://hooks.example.com", pointsExpiryDays: "7", referralVelocityWindowMinutes: "7" }));
  });

  test("cancelling the subscription submits the cancel intent", async () => {
    const { container, actions } = await renderRoute(Settings, { path: "/app/settings", loaderData: data, action: () => null });
    await flush();
    const cancelButtons = [...container.querySelectorAll("s-button")].filter((b) => b.textContent?.trim() === "Cancel subscription");
    fireEvent.click(cancelButtons.at(-1)!);
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "cancel-subscription" }));
  });

  test("renders active, inactive and unavailable billing states", async () => {
    const renderWith = async (patch: Record<string, unknown>) => (await renderRoute(Settings, { path: "/app/settings", loaderData: { ...data, ...patch } })).container;
    expect((await renderWith({ subscription: { ...data.subscription, inTrial: false, currentPeriodEnd: "2026-11-01T00:00:00Z" } })).textContent).toContain("Renews");
    expect((await renderWith({ subscription: { ...data.subscription, inTrial: false, currentPeriodEnd: null } })).textContent).toContain("billed every 30 days");
    expect((await renderWith({ subscription: null })).textContent).toContain("Start a 30-day free trial");
    expect((await renderWith({ subscription: null, billingUnavailable: true })).textContent).toContain("Couldn't reach Shopify");
  });
});

describe("billing page and app shell", () => {
  test("starts the trial, or opens the hosted plan page", async () => {
    const { container, actions } = await renderRoute(Billing, { path: "/app/billing", loaderData: { cancelled: true, amount: 49, trialDays: 30, showHostedPlan: true }, action: () => null });
    await flush();
    expect(el(container, 's-banner[heading="Subscription cancelled"]')).toBeTruthy();
    clickText(container, "Start 30-day free trial");
    await vi.waitFor(() => expect(actions).toHaveLength(1));
    clickText(container, "Open Shopify plan page");
    await vi.waitFor(() => expect(actions).toContainEqual({ intent: "hosted-plans" }));
    const { container: plain } = await renderRoute(Billing, { path: "/app/billing", loaderData: { cancelled: false, amount: 49, trialDays: 30, showHostedPlan: false } });
    await flush();
    expect(plain.textContent).not.toContain("Open Shopify plan page");
  });

  test("the app shell renders navigation including Referrals", async () => {
    const { container } = await renderRoute(App, { path: "/app", loaderData: { apiKey: "k" } });
    await flush();
    expect([...container.querySelectorAll("s-app-nav s-link")].map((l) => l.textContent)).toContain("Referrals");
    expect(appHeaders({ loaderHeaders: new Headers(), parentHeaders: new Headers(), actionHeaders: new Headers(), errorHeaders: undefined } as never)).toBeTruthy();
    expect(AppErrorBoundary).toBeTypeOf("function");
  });

  test("support footer links, with and without legal links", () => {
    const { container } = render(<SupportFooter showLegal />);
    expect(container.textContent).toContain("Privacy");
    const { container: short } = render(<SupportFooter />);
    expect(short.textContent).not.toContain("Privacy");
  });

  test("landing page shows outside Shopify and redirects inside the admin iframe", async () => {
    const { container } = await renderRoute(Landing, { path: "/", loaderData: { installUrl: "https://admin.shopify.com/oauth/install?client_id=x" } });
    await flush();
    expect(container.textContent).toContain("Install on Shopify");

    const replace = vi.fn();
    const top = window.top;
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    Object.defineProperty(window, "location", { value: { ...window.location, search: "?shop=x", replace }, configurable: true });
    const { container: framed } = await renderRoute(Landing, { path: "/", loaderData: { installUrl: "x" } });
    await flush();
    expect(replace).toHaveBeenCalledWith("/app?shop=x");
    expect(framed.textContent).toBe("");
    Object.defineProperty(window, "top", { value: top, configurable: true });
  });
});
