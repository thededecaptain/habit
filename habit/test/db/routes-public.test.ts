import { beforeEach, describe, expect, test, vi } from "vitest";
import * as proxyBalance from "../../app/routes/proxy.balance";
import * as proxyReferralCode from "../../app/routes/proxy.referral-code";
import * as proxyReferralCheck from "../../app/routes/proxy.referral-check";
import * as checkoutPoints from "../../app/routes/checkout-api.points";
import * as checkoutReferralCheck from "../../app/routes/checkout-api.referral-check";
import * as accountPoints from "../../app/routes/account-api.points";
import * as internalJobs from "../../app/routes/internal.jobs";
import * as health from "../../app/routes/health";
import * as privacy from "../../app/routes/privacy";
import * as terms from "../../app/routes/terms";
import * as support from "../../app/routes/support";
import * as appsSplat from "../../app/routes/apps.$";
import * as authSplat from "../../app/routes/auth.$";
import * as authLogin from "../../app/routes/auth.login/route";
import * as landing from "../../app/routes/_index/route";
import { loginErrorMessage } from "../../app/routes/auth.login/error.server";
import { createReferralCode } from "../../app/lib/ledger.server";
import { makeCustomer, makeSettings, prisma } from "../helpers/db";
import { shopify, shopifyServerModule, TEST_SHOP as shop } from "../helpers/shopify";
import { call, get, postJson, quiet } from "../helpers/routes";

beforeEach(() => {
  quiet();
});

const proxy = (path: string, customerId = "") =>
  get(`/proxy/${path}${path.includes("?") ? "&" : "?"}shop=${shop}&logged_in_customer_id=${customerId}`);

describe("app proxy (storefront)", () => {
  test("balance: guests get the public rates, cacheable", async () => {
    const { value } = await call(proxyBalance.loader, proxy("balance"));
    expect(await value.json()).toMatchObject({ loggedIn: false, redemptionRate: 100 });
    expect(value.headers.get("Cache-Control")).toContain("public");
  });

  test("balance: members get their own card, privately cached", async () => {
    await makeCustomer({ shopifyCustomerId: "9", pointsBalance: 300 });
    const { value } = await call(proxyBalance.loader, proxy("balance", "9"));
    expect(await value.json()).toMatchObject({ loggedIn: true, pointsBalance: 300 });
    expect(value.headers.get("Cache-Control")).toBe("private, max-age=45");
  });

  test("balance: an unsigned request gets no data", async () => {
    shopifyServerModule.authenticate.public.appProxy.mockResolvedValue({ session: undefined });
    const { value } = await call(proxyBalance.loader, proxy("balance"));
    expect(await value.json()).toEqual({ loggedIn: false });
  });

  test("referral-code: returns the member's active code, or creates one", async () => {
    const created = await call(proxyReferralCode.action, proxy("referral-code", "9"));
    const { code } = await created.value.json();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const again = await call(proxyReferralCode.action, proxy("referral-code", "9"));
    expect((await again.value.json()).code).toBe(code);
  });

  test("referral-code: skips an expired code and reports the per-member limit", async () => {
    await makeSettings({ maxActiveReferralCodesPerCustomer: 1 });
    await createReferralCode(shop, "9", { code: "OLDCODE" });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "OLDCODE" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { value } = await call(proxyReferralCode.action, proxy("referral-code", "9"));
    expect(value.status).toBe(400);
    expect((await value.json()).error).toContain("at most 1");
  });

  test("referral-code: requires a signed request and a logged-in customer", async () => {
    expect((await call(proxyReferralCode.action, proxy("referral-code"))).value.status).toBe(401);
    shopifyServerModule.authenticate.public.appProxy.mockResolvedValue({ session: undefined });
    expect((await call(proxyReferralCode.action, proxy("referral-code", "9"))).value.status).toBe(401);
  });

  test("referral-code: unexpected errors aren't swallowed", async () => {
    const { withFailingWrites } = await import("../helpers/db");
    await withFailingWrites("ReferralCode", "INSERT", async () => {
      await expect(call(proxyReferralCode.action, proxy("referral-code", "9"))).rejects.toThrow("simulated database failure");
    });
  });

  test("referral-check: validates codes for guests and logged-in shoppers, uncached", async () => {
    await createReferralCode(shop, "owner", { code: "FRIEND", createdByMerchant: true });
    const ok = await call(proxyReferralCheck.loader, proxy("referral-check?code=friend"));
    expect(await ok.value.json()).toEqual({ valid: true, code: "FRIEND", refereeBonusPoints: 250 });
    expect(ok.value.headers.get("Cache-Control")).toBe("private, no-store");
    const self = await call(proxyReferralCheck.loader, proxy("referral-check?code=FRIEND", "owner"));
    expect(await self.value.json()).toEqual({ valid: false, error: "You can't use your own referral code." });
    const missing = await call(proxyReferralCheck.loader, proxy("referral-check"));
    expect((await missing.value.json()).valid).toBe(false);
  });

  test("referral-check: rejects unsigned requests; rethrows real failures", async () => {
    shopifyServerModule.authenticate.public.appProxy.mockResolvedValueOnce({ session: undefined });
    expect((await call(proxyReferralCheck.loader, proxy("referral-check?code=X"))).value.status).toBe(401);
    shopifyServerModule.authenticate.public.appProxy.mockResolvedValueOnce({ session: { shop: undefined } });
    await expect(call(proxyReferralCheck.loader, proxy("referral-check?code=XXXX"))).rejects.toThrow();
  });
});

describe("checkout and customer-account APIs", () => {
  test("checkout points: the buyer comes from the token, not the query string", async () => {
    await makeCustomer({ shopifyCustomerId: "9", pointsBalance: 300 });
    await makeCustomer({ shopifyCustomerId: "victim", pointsBalance: 99999 });
    shopify.sessionSub = "gid://shopify/Customer/9";
    const { value } = await call(checkoutPoints.loader, get("/checkout-api/points?customerId=victim"));
    expect(await value.json()).toMatchObject({ loggedIn: true, pointsBalance: 300 });
  });

  test("checkout points: guests get rates and a zero balance", async () => {
    const { value } = await call(checkoutPoints.loader, get("/checkout-api/points?customerId=gid://shopify/Customer/victim"));
    expect(await value.json()).toMatchObject({ loggedIn: false, pointsBalance: 0, redemptionRate: 100 });
  });

  test("checkout points: a token for a non-shop dest is refused", async () => {
    shopify.sessionDest = "https://evil.example.com";
    const { thrown } = await call(checkoutPoints.loader, get("/checkout-api/points"));
    expect(thrown?.status).toBe(400);
  });

  test("checkout points: the CORS preflight is answered, other methods refused", async () => {
    const { thrown } = await call(checkoutPoints.action, new Request("https://habit.test/checkout-api/points", { method: "OPTIONS" }));
    expect(thrown?.status).toBe(405);
    expect(shopifyServerModule.authenticate.public.checkout).toHaveBeenCalled();
  });

  test("checkout referral check: valid, self, and first-order answers", async () => {
    await createReferralCode(shop, "owner", { code: "FRIEND", createdByMerchant: true });
    const guest = await call(checkoutReferralCheck.loader, get("/checkout-api/referral-check?code=friend"));
    expect(await guest.value.json()).toEqual({ valid: true, code: "FRIEND", refereeBonusPoints: 250 });
    shopify.sessionSub = "gid://shopify/Customer/owner";
    const self = await call(checkoutReferralCheck.loader, get("/checkout-api/referral-check?code=FRIEND"));
    expect((await self.value.json()).valid).toBe(false);
    const none = await call(checkoutReferralCheck.loader, get("/checkout-api/referral-check"));
    expect((await none.value.json()).error).toContain("doesn't exist");
    const { thrown } = await call(checkoutReferralCheck.action, get("/checkout-api/referral-check"));
    expect(thrown?.status).toBe(405);
  });

  test("checkout referral check: rethrows real failures", async () => {
    shopify.sessionSub = "gid://shopify/Customer/9";
    const { withFailingWrites } = await import("../helpers/db");
    await createReferralCode(shop, "owner", { code: "FRIEND", createdByMerchant: true });
    await withFailingWrites("ShopSettings", "INSERT", async () => {
      await prisma.shopSettings.deleteMany();
      // Settings can't be created, so the lookup fails with a database error.
      await expect(call(checkoutReferralCheck.loader, get("/checkout-api/referral-check?code=FRIEND"))).rejects.toThrow();
    });
  });

  test("account points: the member's card with history, from the token", async () => {
    await makeCustomer({ shopifyCustomerId: "9", pointsBalance: 300 });
    shopify.sessionSub = "gid://shopify/Customer/9";
    const { value } = await call(accountPoints.loader, get("/account-api/points"));
    expect(await value.json()).toMatchObject({ loggedIn: true, pointsBalance: 300, history: [] });
    shopify.sessionSub = undefined;
    expect(await (await call(accountPoints.loader, get("/account-api/points"))).value.json()).toEqual({ loggedIn: false });
  });

  test("account referral code: returns the existing code or creates one", async () => {
    shopify.sessionSub = "gid://shopify/Customer/9";
    const first = await (await call(accountPoints.action, postJson("/account-api/points", {}))).value.json();
    const second = await (await call(accountPoints.action, postJson("/account-api/points", {}))).value.json();
    expect(second.code).toBe(first.code);
  });

  test("account referral code: requires sign-in and reports the limit", async () => {
    expect((await call(accountPoints.action, postJson("/account-api/points", {}))).value.status).toBe(401);
    await makeSettings({ maxActiveReferralCodesPerCustomer: 1 });
    await createReferralCode(shop, "9", { code: "GONE" });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "GONE" } }, data: { status: "REVOKED" } });
    await createReferralCode(shop, "9", { code: "STALE" });
    await prisma.referralCode.update({ where: { shop_code: { shop, code: "STALE" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    shopify.sessionSub = "gid://shopify/Customer/9";
    const { value } = await call(accountPoints.action, postJson("/account-api/points", {}));
    expect(value.status).toBe(400);
  });

  test("account referral code: unexpected errors aren't swallowed", async () => {
    shopify.sessionSub = "gid://shopify/Customer/9";
    const { withFailingWrites } = await import("../helpers/db");
    await withFailingWrites("ReferralCode", "INSERT", async () => {
      await expect(call(accountPoints.action, postJson("/account-api/points", {}))).rejects.toThrow("simulated");
    });
  });
});

describe("internal jobs endpoint", () => {
  const auth = { Authorization: "Bearer test-cron-secret" };

  test("runs the outbox job from a JSON body or the query string", async () => {
    const byBody = await call(internalJobs.action, postJson("/internal/jobs", { job: "outbox" }, auth));
    expect(await byBody.value.json()).toMatchObject({ ok: true, job: "outbox", balancesSynced: 0 });
    const byQuery = await call(internalJobs.loader, get("/internal/jobs?job=expire-points&secret=test-cron-secret"));
    expect(await byQuery.value.json()).toEqual({ ok: true, job: "expire-points", expired: 0, expiringSoon: 0 });
  });

  test("refuses wrong or missing secrets, unknown jobs, and an unconfigured cron", async () => {
    expect((await call(internalJobs.action, postJson("/internal/jobs", { job: "outbox" }, { Authorization: "Bearer nope" }))).thrown?.status).toBe(401);
    expect((await call(internalJobs.loader, get("/internal/jobs?job=outbox&secret=wrong-length"))).thrown?.status).toBe(401);
    expect((await call(internalJobs.loader, get("/internal/jobs?job=outbox"))).thrown?.status).toBe(401);
    expect((await call(internalJobs.action, postJson("/internal/jobs", { job: "delete-everything" }, auth))).thrown?.status).toBe(400);
    expect((await call(internalJobs.loader, get("/internal/jobs?secret=test-cron-secret"))).thrown?.status).toBe(400);
    const badJson = new Request("https://habit.test/internal/jobs", { method: "POST", headers: auth, body: "not json" });
    expect((await call(internalJobs.action, badJson)).thrown?.status).toBe(400);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call(internalJobs.loader, get("/internal/jobs?job=outbox"))).thrown?.status).toBe(503);
    vi.unstubAllEnvs();
  });
});

describe("health, redirects, and auth", () => {
  test("health reports the database", async () => {
    const { value } = await call(health.loader as never, get("/health"));
    expect(await value.json()).toMatchObject({ ok: true, db: "ok", service: "habit" });
  });

  test("health reports a database outage as 503", async () => {
    const original = process.env.DATABASE_URL;
    const { PrismaClient } = await import("@prisma/client");
    const broken = new PrismaClient({ datasourceUrl: "postgresql://nobody:x@localhost:1/none" });
    const g = globalThis as { prismaGlobal?: unknown };
    const saved = g.prismaGlobal;
    vi.resetModules();
    g.prismaGlobal = broken;
    const fresh = await import("../../app/routes/health");
    const { value } = await call(fresh.loader as never, get("/health"));
    expect(value.status).toBe(503);
    expect(await value.json()).toMatchObject({ ok: false, db: "error" });
    g.prismaGlobal = saved;
    process.env.DATABASE_URL = original;
  });

  test("/privacy, /terms and /support redirect to the real pages", async () => {
    expect((privacy.loader() as Response).headers.get("Location")).toBe("https://gethabitloyalty.com/privacy");
    expect((terms.loader() as Response).headers.get("Location")).toBe("https://gethabitloyalty.com/terms");
    expect((support.loader() as Response).headers.get("Location")).toBe("https://docs.gethabitloyalty.com/support");
    expect((privacy.loader() as Response).status).toBe(301);
  });

  test("/apps/* sends Shopify's post-charge iframe back into the app", async () => {
    const { thrown } = await call(appsSplat.loader, get("/apps/habit-loyalty?charge_id=1"));
    expect(thrown?.headers.get("Location")).toBe("/app?charge_id=1");
  });

  test("the landing page forwards embedded loads into the app", async () => {
    const { thrown } = await call(landing.loader, get("/?shop=x.myshopify.com&host=abc"));
    expect(thrown?.headers.get("Location")).toBe("/app?shop=x.myshopify.com&host=abc");
    for (const param of ["embedded=1", "plan_handle=standard", "charge_id=5"]) {
      expect((await call(landing.loader, get(`/?${param}`))).thrown?.status).toBe(302);
    }
    expect((await call(landing.loader, get("/"))).value).toEqual({ installUrl: expect.stringContaining("oauth/install") });
    expect(landing.meta({} as never)).toContainEqual({ title: "Habit" });
  });

  test("auth routes authenticate or send merchants to the App Store install", async () => {
    expect((await call(authSplat.loader, get("/auth/callback"))).value).toBeNull();
    expect(shopifyServerModule.authenticate.admin).toHaveBeenCalled();

    shopifyServerModule.login.mockResolvedValue({ shop: "MISSING_SHOP" });
    expect((await call(authLogin.loader, get("/auth/login"))).thrown?.headers.get("Location")).toContain("oauth/install");
    shopifyServerModule.login.mockResolvedValue({});
    expect((await call(authLogin.loader, get("/auth/login"))).value).toBeNull();
    expect((await call(authLogin.action, get("/auth/login"))).thrown?.status).toBe(302);
    expect(authLogin.default()).toBeNull();
  });

  test("login error messages", () => {
    expect(loginErrorMessage({ shop: "MISSING_SHOP" } as never)).toEqual({ shop: "Please enter your shop domain to log in" });
    expect(loginErrorMessage({ shop: "INVALID_SHOP" } as never)).toEqual({ shop: "Please enter a valid shop domain to log in" });
    expect(loginErrorMessage({} as never)).toEqual({});
    expect(loginErrorMessage(undefined as never)).toEqual({});
  });
});
