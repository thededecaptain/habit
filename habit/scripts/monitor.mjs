#!/usr/bin/env node
/**
 * Production monitor, run every 15 minutes by .github/workflows/monitor.yml
 * (and by hand: `npm run monitor`). Checks what a reviewer or a broken
 * deploy would hit first, from the outside, with no secrets:
 *  - the app and its database are up;
 *  - public pages and redirects answer (no 404s, the thing review cites);
 *  - every webhook, app proxy, extension and cron endpoint refuses an
 *    unsigned or tampered request cleanly (4xx), never with a 404 or 5xx.
 * Exits non-zero if anything fails, which fails the workflow run and makes
 * GitHub send a failure notification.
 */

const baseUrl = (process.env.HABIT_URL || "https://habit-production-9257.up.railway.app").replace(/\/$/, "");
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
}

function expectStatus(res, allowed, path) {
  if (!allowed.includes(res.status)) {
    throw new Error(`${path} answered ${res.status}, expected ${allowed.join(" or ")}`);
  }
  return `HTTP ${res.status}`;
}

await check("health: app up, database reachable", async () => {
  const res = await request("/health");
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body.ok || body.db !== "ok") {
    throw new Error(`/health answered ${res.status} ${JSON.stringify(body)}`);
  }
  return `db=${body.db}, ${body.latencyMs}ms, version ${body.version ?? "?"}`;
});

await check("landing page", async () => expectStatus(await request("/"), [200], "/"));
await check("robots.txt", async () => expectStatus(await request("/robots.txt"), [200], "/robots.txt"));

for (const [path, target] of [
  ["/privacy", "https://gethabitloyalty.com/privacy"],
  ["/terms", "https://gethabitloyalty.com/terms"],
  ["/support", "https://docs.gethabitloyalty.com/support"],
]) {
  await check(`${path} redirects to the real page`, async () => {
    const res = await request(path);
    expectStatus(res, [301, 302], path);
    const location = res.headers.get("location");
    if (location !== target) throw new Error(`${path} redirects to ${location}, expected ${target}`);
    return `→ ${location}`;
  });
}

for (const path of [
  "/webhooks/orders/paid",
  "/webhooks/refunds/create",
  "/webhooks/app/uninstalled",
  "/webhooks/app/subscriptions_update",
  "/webhooks/app/scopes_update",
  "/webhooks/customers/data_request",
  "/webhooks/customers/redact",
  "/webhooks/shop/redact",
]) {
  await check(`webhook ${path} rejects an unsigned delivery`, async () =>
    expectStatus(
      await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      [400, 401],
      path,
    ),
  );
}

for (const path of ["/proxy/balance", "/proxy/referral-check?code=TEST", "/proxy/referral-code"]) {
  await check(`app proxy ${path.split("?")[0]} rejects a forged signature`, async () => {
    const query = `shop=monitor.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fhabit&timestamp=${Math.floor(Date.now() / 1000)}&signature=${"0".repeat(64)}`;
    const url = `${path}${path.includes("?") ? "&" : "?"}${query}`;
    const method = path.startsWith("/proxy/referral-code") ? "POST" : "GET";
    return expectStatus(await request(url, { method }), [400, 401], path);
  });
}

for (const path of ["/checkout-api/points", "/checkout-api/referral-check?code=TEST", "/account-api/points"]) {
  await check(`extension API ${path.split("?")[0]} requires a session token`, async () =>
    expectStatus(await request(path), [401], path),
  );
  await check(`extension API ${path.split("?")[0]} answers the CORS preflight`, async () =>
    expectStatus(
      await request(path, {
        method: "OPTIONS",
        headers: { Origin: "https://extensions.shopifycdn.com", "Access-Control-Request-Method": "GET" },
      }),
      [200, 204],
      path,
    ),
  );
}

await check("cron endpoint refuses requests without the secret", async () =>
  expectStatus(await request("/internal/jobs", { method: "POST", body: '{"job":"outbox"}' }), [401], "/internal/jobs"),
);

await check("embedded app entry answers without a session (no 5xx)", async () => {
  const res = await request("/app");
  if (res.status >= 500) throw new Error(`/app answered ${res.status}`);
  return `HTTP ${res.status}`;
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${baseUrl}`);
if (failed.length) process.exit(1);
