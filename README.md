# Habit — Project Brief

**Habit** is a solo-founder Shopify app: a flat-fee, self-serve loyalty & rewards app for small
merchants ($5K–$50K/month GMV) who've outgrown Smile.io's thin starter tier but aren't ready for
the $199+/month cliff every incumbent (Smile.io, LoyaltyLion, Yotpo) shares. The name ties directly
to the product's differentiator: reward logic built around purchase *habits* (cadence), not just
raw order counts.

Full research and planning docs are in `/docs`. This file is the condensed version — enough
context to start a Cursor/Claude Code session without re-reading everything.

## Naming check (Aug 2026)

- **Shopify App Store**: no existing app named "Habit" (exact-match search returned 19 unrelated
  apps, none named Habit). Confirmed clear.
- A separate app called "Cadence" already exists on the App Store (a pricing/promotions tool,
  unrelated category) — and its own URL slug is `cadence-2`, meaning even that developer couldn't
  get the plain "Cadence" slug. That name was ruled out for this reason.
- **Domains**: `gethabit.com`, `habitloyalty.com`, and `joinhabit.com` all appear unregistered/parked
  (returned no live site content) — best guess `habitloyalty.com` for the product domain, but confirm
  at a registrar before buying. `usehabit.com` is taken by an unrelated small laundry business.
- Not checked: USPTO/trademark search. Worth a proper search before committing to the name publicly,
  since "Habit" is a common word used elsewhere (e.g. The Habit Burger Grill, various wellness apps)
  — low risk for a Shopify app in a different category, but not zero.

## The wedge

Loyalty & Rewards was the most underserved of four candidate Shopify App Store categories
(Subscriptions, Loyalty, Upsell/Cross-sell, Reviews) — see `docs/solo_founder_shopify_niche_research.xlsx`
for the full competitor matrix. Real merchant reviews on Smile.io and LoyaltyLion's Shopify
listings (`Outreach Targets` tab in that spreadsheet) validate the specific pain points below.

## What v1 must do (launch blockers)

- Points ledger: earn on purchase (configurable rate), redeem as a checkout discount.
- VIP tiers: 2–3 configurable spend/order thresholds with different earn multipliers.
- Referral program in the **same ledger** — no separate app/fee for referrals.
- Flat, published, self-serve pricing. No order-count cliff, no gated features.
- **Real self-serve cancel** — a working Cancel button, not a support-ticket-only flow.
  (LoyaltyLion reviewers HouseofDogs.no and "Blink outside the box" both reported being
  unable to cancel/uninstall without fighting support for days.)
- **Automatic refund clawback** — refunding an order automatically reverses the points it
  earned via webhook. (Smile.io reviewer "CB Hobby": this is currently a manual process.)
- **Basic referral fraud protection** — rate-limit code generation, expire unused codes,
  alert on abnormal volume. (Smile.io reviewer Karine Sultan: 12,000+ referral codes leaked
  to coupon sites with no recourse from support.)

## Should-have (differentiator, v1 if time allows / fast-follow otherwise)

- **Cadence-based reward triggers** for replenishment/subscription brands (coffee,
  supplements, pet, beauty): reward logic keys off whether a customer's reorder is overdue
  relative to their own purchase history, not just raw order count. None of the four
  incumbents in the competitor matrix are built around this.

## Explicitly out of scope for v1

- POS / in-person redemption sync (broken even on paid Smile.io — v2 problem).
- Multi-language/translation tooling (BON Loyalty already owns this niche).
- Custom landing pages / marketing automation (this complexity is exactly what pushes
  Smile.io merchants toward their $199/mo tier — the thing you're positioned against).

## Tech stack

- **Shopify CLI** + official app template, scaffolded with **React Router** (Shopify's
  current guidance — not the older Remix template, even though the npm package is still
  named `shopify-app-remix`).
- **Shopify Admin GraphQL API** for orders/customers/discounts; **Polaris** for every
  embedded admin screen (required for App Store approval).
- **Theme App Extension** (app embed block) for the storefront points widget — installs
  into any Online Store 2.0 theme from the Theme Editor, zero manual theme-code edits.
- **Checkout UI Extension** for point redemption at checkout. Shopify Scripts are fully
  deprecated as of June 30, 2026 — there is no legacy fallback, this is the only supported path.
- **Shopify App Pricing** (current managed billing product, supersedes the old Billing API)
  for the recurring monthly charge — handles proration, trials, plan changes.
- A small managed **Postgres** instance (Supabase or Railway) for the points ledger and
  cadence-tracking data that lives outside Shopify's own data model.

## Build phases (~9 weeks solo)

| Phase | Timeframe | Exit criteria |
|---|---|---|
| 0. Setup | Days 1–3 | App installs on dev store, empty Polaris admin screen |
| 1. Core ledger | Week 1–2 | Merchant can configure a program end-to-end in dev store admin |
| 2. Storefront + checkout | Week 2–3 | Customer can see points, refer a friend, redeem at checkout |
| 3. Differentiators | Week 3–4 | All 6 must-have items verified working |
| 4. Billing + compliance | Week 5 | Billing charges correctly; 3 GDPR webhooks + app/uninstalled all pass |
| 5. Listing assets | Week 6 | Everything on Shopify's App Requirements Checklist complete |
| 6. Submit + review | Week 6–9 | App status reaches Published (review typically 2–4 weeks) |
| 7. Launch | Week 9+ | First installs, review flywheel started via Outreach Targets list |

Full detail, submission checklist, and sources: `docs/shopify_mvp_build_and_launch_plan.docx`.

## Distribution plan

Shopify App Store organic search — merchants already search with the problem in hand.
0% revenue share on first $1M lifetime app-store revenue. First 15–20 reviews should come
from the merchants in the `Outreach Targets` tab of the research spreadsheet — lead with
**Avernic Smoke Shop** (5-year LoyaltyLion customer, hit with an unannounced price hike,
explicitly said in their public review they're looking for a new provider).

Full market scan, why this beats other solo-founder options, and backup plays (AI-native
service, Chrome extension): `docs/solo_founder_digital_business_recommendation.docx`.

## Suggested first Cursor/Claude Code prompt

> Read README.md in this repo for full context. Set up a Shopify Partner account walkthrough
> for me, then scaffold a new Shopify app named "habit" using the Shopify CLI with the React
> Router template. Target Node LTS. Once scaffolded, set up a Postgres schema (via Prisma) for
> a points ledger: customers, point_transactions (earn/redeem/refund-reversal), referral_codes,
> and vip_tiers. Don't build UI yet — just get OAuth install working end-to-end on a dev store
> and the schema migrated.

## Docs index

- `docs/solo_founder_digital_business_recommendation.docx` — why this idea, why Shopify App
  Store as a distribution channel, backup plays, market scan (YC, MCP ecosystem, ChatGPT/Claude
  app stores).
- `docs/solo_founder_shopify_niche_research.xlsx` — competitor matrix across 4 categories,
  gap ranking, and the real reviewer outreach list.
- `docs/shopify_mvp_build_and_launch_plan.docx` — full build plan, tech stack detail, and the
  literal Shopify App Store submission checklist.
