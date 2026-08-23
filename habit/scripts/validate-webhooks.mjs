#!/usr/bin/env node
/**
 * Guard against relative webhook URIs resolving under application_url (/app).
 * Run in CI: node scripts/validate-webhooks.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toml = readFileSync(join(root, "shopify.app.toml"), "utf8");

const applicationUrlMatch = toml.match(/^application_url\s*=\s*"([^"]+)"/m);
const applicationUrl = applicationUrlMatch?.[1] ?? "";

const uris = [...toml.matchAll(/^\s*uri\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
const privacyUrls = [
  ...toml.matchAll(
    /^\s*(customer_deletion_url|customer_data_request_url|shop_deletion_url)\s*=\s*"([^"]+)"/gm,
  ),
].map((m) => m[2]);

const allUrls = [...uris, ...privacyUrls];

if (allUrls.length === 0) {
  console.error("✗ No webhook URIs found in shopify.app.toml");
  process.exit(1);
}

let failed = false;

for (const url of allUrls) {
  if (!url.startsWith("https://")) {
    console.error(`✗ Webhook URI must be absolute (https://): ${url}`);
    failed = true;
    continue;
  }

  if (url.includes("/app/webhooks")) {
    console.error(
      `✗ Webhook URI must not live under /app (404 during review): ${url}`,
    );
    failed = true;
  }
}

if (applicationUrl.endsWith("/app") && uris.some((u) => !u.startsWith("https://"))) {
  console.error(
    "✗ application_url ends with /app — relative webhook URIs would resolve to /app/webhooks/*",
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(`✓ ${allUrls.length} webhook URIs are absolute and not under /app`);
