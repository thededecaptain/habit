# Habit — App Store listing copy

Use this text in the **Partner Dashboard → Apps → Habit → Distribution → App listing**. Keep pricing and trial language identical on [gethabitloyalty.com](https://gethabitloyalty.com) (see `MARKETING_SITE_CHECKLIST.md`).

## App name

Habit

## Tagline (≤ 60 chars)

Loyalty points, VIP tiers, and referrals — one flat plan.

## Pricing (App Pricing / Managed Pricing)

| Plan | Price | Trial |
| --- | --- | --- |
| Standard | **$49 USD** every **30 days** | **30-day** free trial |

- One plan only — no usage meter, no hidden tiers.
- Merchants cancel from **Settings** inside the app (no email required).

## Short description

Points, VIP tiers, and referrals in one loyalty program. Customers earn on every order, redeem at checkout, and refer friends — on a single $49/month plan with a 30-day trial.

## Detailed description

**Habit** is a loyalty and rewards app built for Shopify merchants who want points, VIP tiers, and referrals without juggling multiple apps or surprise fees.

**Earn on every purchase** — Members earn points on order subtotal. You control the earn rate, redemption value, and whether tax/shipping count toward earn.

**VIP tiers that stick** — Set spend- or order-based tiers with earn multipliers. Once a customer reaches a tier, they keep it — no demotion surprises.

**Referrals in the same ledger** — Refer-a-friend codes, welcome bonuses, and purchase earn all live in one balance. Built-in velocity alerts help you spot abnormal code generation.

**Redeem at checkout** — A checkout UI extension lets logged-in members apply points as a discount. A Shopify Function enforces redemption rules server-side.

**Storefront ready** — Theme app extension blocks for balance display and redeem, plus a customer account extension for members.

**Notifications your way** — Habit emits events to **Shopify Flow** (points earned, tier upgrades, referrals, expiry, and more). Connect Flow to Klaviyo, Shopify Email, Slack, or any Flow-compatible app. Optionally set a **webhook URL** in Settings for your own automation.

**Flat, transparent billing** — $49/month after a 30-day trial. Cancel anytime from Settings.

## Key features (bullets for listing form)

- Points on purchase with configurable earn and redeem rates
- VIP tiers with permanent tier status and earn multipliers
- Refer-a-friend with code limits and shop-wide velocity alerts
- Checkout redemption via UI extension + Shopify Function
- Theme widget and customer account balance
- Shopify Flow triggers for loyalty events
- Optional merchant webhook for custom integrations
- Self-serve subscription cancel in app
- GDPR webhooks (customer/shop data request and redact)

## What Habit does **not** include

- Built-in email or SMS campaigns (use Shopify Flow + your email app)
- Klaviyo API key field (use Flow → Klaviyo instead)
- POS integration
- Multi-currency earn rules beyond Shopify's order currency

## Demo / review notes for Shopify

**Test store:** Provide a dev store with the app installed, trial active, and at least one test customer with points.

**Flow:** Flow triggers require a store plan that includes Shopify Flow (Advanced/Plus). Reviewers can verify loyalty logic without Flow; webhook URL in Settings is an alternative notification path.

**Billing:** Start trial from in-app Billing screen. Standard plan is $49/30 days with 30-day trial.

**Privacy:** https://gethabitloyalty.com/privacy  
**Terms:** https://gethabitloyalty.com/terms  
**Support:** support@gethabitloyalty.com

## Screenshots

Assets in repo root `listing-assets/` (1600×900):

1. Dashboard / Home
2. VIP tiers
3. Points & referrals

Upload PNG/JPG versions to Partner Dashboard. Ensure screenshots show current UI (Flow notifications section, not legacy Klaviyo fields).
