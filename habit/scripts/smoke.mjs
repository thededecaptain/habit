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

async function main() {
  console.log(`Smoke testing ${baseUrl}\n`);
  await checkHealth();
  await checkLanding();
  console.log("\nAutomated smoke checks passed.");
  console.log(
    "Complete manual steps in listing/SMOKE_TEST.md before App Store submission.",
  );
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:", err.message);
  process.exit(1);
});
