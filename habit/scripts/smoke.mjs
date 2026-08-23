#!/usr/bin/env node
/**
 * Automated smoke checks against a deployed Habit instance.
 * Usage: HABIT_URL=https://habit-production-9257.up.railway.app npm run smoke
 */

const baseUrl = (process.env.HABIT_URL || "https://habit-production-9257.up.railway.app").replace(
  /\/$/,
  "",
);

async function checkHealth() {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(`Health check failed (${res.status}): ${JSON.stringify(body)}`);
  }
  console.log(`✓ /health — db=${body.db}, latency=${body.latencyMs}ms`);
  return body;
}

async function checkLanding() {
  const res = await fetch(baseUrl, { redirect: "manual" });
  if (res.status >= 500) {
    throw new Error(`Landing page returned ${res.status}`);
  }
  console.log(`✓ / — HTTP ${res.status}`);
}

/** POST without HMAC — route must exist (400/401), not 404/405/500. */
async function checkWebhookRoute(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status === 404 || res.status === 405) {
    throw new Error(`${path} returned ${res.status} — Shopify webhooks will fail`);
  }
  if (res.status >= 500) {
    throw new Error(`${path} returned ${res.status} before auth`);
  }
  console.log(`✓ POST ${path} — HTTP ${res.status} (route reachable)`);
}

async function checkWebhookRoutes() {
  const paths = [
    "/webhooks/app/uninstalled",
    "/webhooks/app/subscriptions_update",
    "/webhooks/shop/redact",
    "/webhooks/customers/redact",
    "/webhooks/orders/paid",
    // Legacy URLs registered when relative URIs resolved under application_url (/app)
    "/app/webhooks/app/uninstalled",
    "/app/webhooks/app/subscriptions_update",
    "/app/webhooks/shop/redact",
    "/app/webhooks/customers/redact",
  ];
  for (const path of paths) {
    await checkWebhookRoute(path);
  }
}

async function main() {
  console.log(`Smoke testing ${baseUrl}\n`);
  await checkHealth();
  await checkLanding();
  await checkWebhookRoutes();
  console.log("\nAutomated smoke checks passed.");
  console.log(
    "Complete manual steps in listing/SMOKE_TEST.md before App Store submission.",
  );
  console.log(
    "Also confirm Partner Dashboard → Monitoring → Webhooks shows <5% failures.",
  );
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err.message);
  process.exit(1);
});
