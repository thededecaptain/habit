import { describe, expect, test, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import Referrals from "../../app/routes/app.referrals";
import { appBridge, clickText, el, flush, renderRoute, typeInto } from "../helpers/ui";

const loaderData = {
  q: "",
  status: "all",
  page: 1,
  hasNext: false,
  stats: { active: 2, redeemed: 1, bonusPoints: 750 },
  settings: { referrerBonusPoints: 500, refereeBonusPoints: 250, referralCodeExpiryDays: 30 },
  codes: [
    { id: "c1", code: "FRIEND10", status: "ACTIVE", owner: { id: "m1", label: "Ann" }, redeemedBy: null, redeemedAt: null, createdAt: "2026-09-01T00:00:00Z", expiresAt: null },
    { id: "c2", code: "USED1", status: "REDEEMED", owner: { id: "m1", label: "Ann" }, redeemedBy: { id: "m2", label: "Bo" }, redeemedAt: "2026-09-02T00:00:00Z", createdAt: "2026-09-01T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z" },
  ],
};

const searchRoute = {
  path: "/app/customer-search",
  loader: () => ({ customers: [{ id: "321", email: "new@example.com", displayName: "New Friend" }, { id: "9", email: null, displayName: null }], error: null }),
};

describe("Referrals page", () => {
  test("shows stats, codes, and how referrals work", async () => {
    const { container } = await renderRoute(Referrals, { path: "/app/referrals", loaderData, extraRoutes: [searchRoute] });
    expect(await screen.findByText("FRIEND10")).toBeTruthy();
    expect(screen.getByText("750")).toBeTruthy();
    expect(screen.getByText("Bo")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(container.textContent).toContain("500 points");
    // Only the active code can be revoked.
    expect([...container.querySelectorAll("s-button")].filter((b) => b.textContent === "Revoke")).toHaveLength(1);
  });

  test("creates a code for a customer picked from Shopify", async () => {
    const { container, actions } = await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData,
      action: () => ({ created: "PAL20" }),
      extraRoutes: [searchRoute],
    });
    fireEvent.click(await screen.findByText("New Friend"));
    expect(screen.getByText("new@example.com")).toBeTruthy();
    typeInto(el(container, 's-text-field[label="Code"]'), "pal20");
    typeInto(el(container, 's-number-field[label="Expires after (days)"]'), "");
    clickText(container, "Create code");
    await flush();
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Referral code PAL20 created"));
    expect(actions[0]).toEqual({ intent: "create", shopifyCustomerId: "321", code: "pal20", expiresInDays: "" });
  });

  test("shows field errors from the server and lets the merchant change the customer", async () => {
    const { container } = await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData,
      action: () => ({ errors: { customer: "Choose the customer who will share this code.", code: "The code X is already in use." } }),
      extraRoutes: [searchRoute],
    });
    fireEvent.click(await screen.findByText("Customer 9"));
    clickText(container, "Change");
    clickText(container, "Create code");
    await vi.waitFor(() => expect(el(container, 's-text-field[label="Code"]').getAttribute("error")).toContain("already in use"));
  });

  test("customer search is debounced and reports failures", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loader = vi.fn(() => ({ customers: [], error: "Couldn't search customers. Try again." }));
    const { container } = await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData,
      extraRoutes: [{ path: "/app/customer-search", loader }],
    });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const search = el(container, 's-search-field[label="Referrer"]');
    typeInto(search, "a");
    typeInto(search, "an");
    typeInto(search, "ann");
    await vi.advanceTimersByTimeAsync(350);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Couldn't search customers. Try again.")).toBeTruthy();
  });

  test("an empty search result says so", async () => {
    await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData,
      extraRoutes: [{ path: "/app/customer-search", loader: () => ({ customers: [], error: null }) }],
    });
    expect(await screen.findByText("No customers found.")).toBeTruthy();
  });

  test("revokes a code and copies codes to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { container, actions } = await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData,
      action: () => ({ revoked: true }),
      extraRoutes: [searchRoute],
    });
    await screen.findByText("FRIEND10");
    clickText(container, "Revoke");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Referral code revoked"));
    expect(actions[0]).toEqual({ intent: "revoke", codeId: "c1" });

    clickText(container, "Copy");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Copied FRIEND10"));
    writeText.mockRejectedValueOnce(new Error("blocked"));
    clickText(container, "Copy");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Couldn't copy — select the code instead", { isError: true }));
  });

  test("an already-inactive code is reported on revoke", async () => {
    const { container } = await renderRoute(Referrals, { path: "/app/referrals", loaderData, action: () => ({ revoked: false }), extraRoutes: [searchRoute] });
    await screen.findByText("FRIEND10");
    clickText(container, "Revoke");
    await vi.waitFor(() => expect(appBridge.toast.show).toHaveBeenCalledWith("Code was already inactive"));
  });

  test("search and status filters update the URL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container } = await renderRoute(Referrals, {
      path: "/app/referrals",
      loaderData: { ...loaderData, q: "ann", status: "active", page: 2, hasNext: true },
      url: "/app/referrals?q=ann&status=active&page=2",
      extraRoutes: [searchRoute],
    });
    await screen.findByText("FRIEND10");
    expect(el(container, 's-button[href="/app/referrals?q=ann&status=active"]')).toBeTruthy();
    expect(el(container, 's-button[href="/app/referrals?q=ann&status=active&page=3"]')).toBeTruthy();
    typeInto(el(container, 's-select[label="Status"]'), "all");
    typeInto(el(container, 's-search-field[label="Search referral codes"]'), "");
    await vi.advanceTimersByTimeAsync(350);
  });

  test("empty states", async () => {
    await renderRoute(Referrals, { path: "/app/referrals", loaderData: { ...loaderData, codes: [] }, extraRoutes: [searchRoute] });
    expect(await screen.findByText(/No referral codes yet/)).toBeTruthy();
    await renderRoute(Referrals, { path: "/app/referrals", loaderData: { ...loaderData, codes: [], q: "zzz" }, extraRoutes: [searchRoute] });
    expect(await screen.findByText("No referral codes match these filters.")).toBeTruthy();
  });
});
