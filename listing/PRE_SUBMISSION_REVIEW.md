# Habit — pre-submission App Store review

Generated from Shopify's [AI self-review requirements](https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements) against the local codebase (August 2026).

**Note:** Shopify will re-check all requirements at submission. This report covers only requirements verifiable from code.

## Summary

✅ **Likely passing:** 38  
❌ **Likely failing:** 0  
⚠️ **Needs review:** 4  
⏭️ **Groups skipped:** 8 _(see below)_

## ⚠️ Requirements that need review

⚠️ **2.3.1 Initiate installation from a Shopify-owned surface**

**Why this needs attention:** The public landing page at `/_index` includes a shop-domain login form for direct access outside Shopify admin. App Store installs normally go through OAuth from Shopify; this form is for returning merchants or dev use.

**What was detected:** `habit/app/routes/_index/route.tsx` renders a `your-store.myshopify.com` input when not embedded. Embedded installs (the review path) redirect to `/app` immediately.

⚠️ **5.1.3 Include detailed onboarding instructions for theme app extensions**

**Why this needs attention:** Deep links exist on Home, but reviewers may expect step-by-step copy in help docs too.

**What was detected:** `app._index.tsx` links to `shopify://admin/themes/current/editor?context=apps&activateAppId=.../redeem_points_embed`. Mintlify `storefront.mdx` should be verified for completeness before submit.

⚠️ **GDPR customers/data_request handling**

**Why this needs attention:** Webhook authenticates and logs but does not auto-export customer data to the merchant. Acceptable for minimal PII storage, but document in privacy policy.

**What was detected:** `webhooks.customers.data_request.tsx` logs ledger presence; `customers/redact` scrubs email and displayName; `shop/redact` deletes shop data.

⚠️ **Listing factual accuracy (1.1.4)**

**Why this needs attention:** Marketing site is outside this repo and may still show outdated $29 / 14-day trial copy.

**What was detected:** App code and Mintlify docs use $49 / 30-day trial. See `listing/MARKETING_SITE_CHECKLIST.md`.

## ❌ Requirements that are likely failing

None identified from codebase review.

## Skipped groups

- **5.5 Product sourcing** — Opt-in; not requested
- **5.7 Sales channel** — No `channel_config` extension
- **5.8 Post purchase** — No `checkout_post_purchase` extension
- **5.9 Mobile app builders** — Opt-in; not requested
- **5.10 Donation** — Opt-in; not requested
- **1.1.7 Payment Gateway** — No payment gateway app
- **1.1.8 Third-party POS** — No external POS integration
- **5.2 Payment gateway (5.2.x)** — No payment gateway extension

## Key passing areas (verified in code)

| Requirement | Evidence |
| --- | --- |
| 1.1.1 Session tokens | `@shopify/shopify-app-react-router`, embedded `AppProvider`, no localStorage auth |
| 1.2.1 / 1.2.2 Billing | App Pricing + Billing API in `billing.server.ts`, `requireStandardPlan`, cancel in Settings |
| 2.2.3 App Bridge | `@shopify/app-bridge-react` ^4.2.x |
| 2.2.4 GraphQL Admin API | All admin calls use `admin.graphql()` |
| 2.3.2–2.3.4 OAuth | `shopifyApp` auth, `afterAuth` bootstrap, reinstall-safe session storage |
| 3.1.1 TLS | Production on Railway HTTPS |
| 5.1.1 Theme app extensions | `points-widget` theme extension; no ScriptTag or Asset API |
| 5.6.x Checkout extension | Redeem requires explicit buyer action; no countdown timers found |
| Privacy webhooks | Configured in `shopify.app.toml` |

## Before you click Submit

1. Run manual steps in `listing/SMOKE_TEST.md` (or `npm run smoke` after deploy).
2. Paste listing copy from `listing/APP_STORE_LISTING.md` into Partner Dashboard.
3. Update gethabitloyalty.com per `listing/MARKETING_SITE_CHECKLIST.md`.
4. Set `SENTRY_DSN` on Railway.
5. Provide reviewers a dev store with trial active and a test customer with points.

## Resources

- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- [Submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
- [Billing for apps](https://shopify.dev/docs/apps/launch/billing)
