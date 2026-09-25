# Pre-submission smoke test (internal)

Run these checks on a **clean browser profile** (or incognito) so Shopify admin cookies do not cause HTTP 431 during install.

## Automated

### Test suite (`cd habit && npm test`)

- **App tests** (`npm run test:app`, Vitest, ~300 tests) in `habit/test/`:
  - `unit/`: pure logic (Flow payloads, webhook HMAC fallback, retries, URL guards, discount math).
  - `db/`: ledger, refunds, referrals, tiers, expiry, balance sync, notifications, billing, and every route's loader/action, against a real throwaway Postgres 17 (`embedded-postgres`) with every migration applied fresh. Nothing touches production.
  - `ui/`: every admin page rendered in jsdom (create/revoke codes, adjust points, tiers, settings save bar, dashboard).
  - `storefront/`: the theme scripts against Dawn's real cart and drawer markup.
  - `extensions/`: the checkout, Thank you, and customer account blocks.
  - Coverage thresholds live in `habit/vitest.config.ts`; the run fails if coverage drops.
- **Shopify Function tests** (`npm run test:functions`): discount capping, including guests and tampered carts.

`npm run test:watch` re-runs tests as you edit.

### CI and scheduled runs (GitHub Actions)

- **`.github/workflows/ci.yml`**: on every push/PR to `main` and **nightly**: webhook config, typecheck, lint, build, app tests with coverage (report uploaded as an artifact), function tests.
- **`.github/workflows/monitor.yml`**: **every 15 minutes** against production (`npm run monitor` runs it by hand): health and database, `/privacy` `/terms` `/support` redirects, and that every webhook, app proxy, extension API and cron endpoint refuses unsigned or tampered requests with a 4xx, never a 404 or 5xx. A failed run triggers GitHub's failure notification.

`npm run smoke` (older, lighter) still works for a quick check.

## Manual checklist (~30 minutes)

Use a dev store where you can complete a test purchase (Advanced or Plus if you want to verify **Shopify Flow** triggers; webhooks work on any plan).

### Install and billing

1. Install **Habit** from the App Store (or Partner install link).
2. Confirm OAuth completes and you land in the embedded admin.
3. Go to **Billing** → start the **30-day Standard trial** ($49/month after trial).
4. Confirm Home, Members, VIP tiers, and Settings unlock after trial starts.

### Program settings

1. Open **Settings** → set points per dollar, redemption rate, referral bonus.
2. Save → values persist without page refresh or blank screen.
3. Set an optional notification webhook URL (use webhook.site for a one-off test).

### Earn points

1. Place a **paid test order** with a logged-in customer email.
2. Confirm points appear on **Members** and the member detail ledger.
3. If webhook URL is set, confirm a `points-earned` JSON POST arrives.

### Redeem at checkout

1. Enable the checkout UI extension on your store.
2. Add items to cart as a member with points → redeem at checkout.
3. Confirm discount applies and balance decreases.

### Referrals

1. Generate a referral code (storefront widget or customer account extension).
2. Complete a referred purchase → both parties get ledger entries.

### Cancel and uninstall

1. **Settings → Cancel subscription** → confirm banner and access ends appropriately.
2. Reinstall → can start a new trial from **Billing**.
3. Uninstall app → no 500 errors; shop data scrubbed per GDPR webhooks.

## Partner Dashboard alignment

Before submit, confirm listing copy matches the live app:

| Field | Value |
| --- | --- |
| Price | **$49 USD / month** (30-day billing cycle) |
| Trial | **30 days** |
| Notifications | Via **Shopify Flow triggers** + optional merchant webhook — not built-in email |
| Cancel | Self-serve in **Settings** — no support ticket |

See `listing/APP_STORE_LISTING.md` for full listing copy.

## Observability after deploy

Set `SENTRY_DSN` on Railway to capture unhandled server errors. Check `/health` returns `{ "ok": true, "db": "ok" }`.

**Partner Dashboard → Monitoring → Webhooks:** failure rate should stay below ~5%. Spikes on `app/uninstalled`, `shop/redact`, or `app_subscriptions/update` during review will block approval — check this **before** clicking Submit, not after.

Query failed notification deliveries in Postgres: `NotificationOutbox` rows with `status = 'FAILED'`.
