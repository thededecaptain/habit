# Habit — Build List

Context for whoever (human or Cursor) picks this up: Habit is a Shopify loyalty
app (points ledger, VIP tiers, referrals, checkout-time redemption via a
Shopify Function). The core loop already works end-to-end and is genuinely
solid — idempotent webhooks, transaction-safe ledger writes, defense-in-depth
discount capping, real self-serve billing cancel. This list is gaps found in a
full code review, not a rewrite. Each item references the actual files
involved so changes can be scoped without re-discovering the codebase.

Priority: P0 = do first, P1 = next, P2 = worth doing, not urgent.
Effort is a rough t-shirt size (S/M/L), not a real estimate — validate before committing to a timeline.

---

## P0 — Customer lifecycle notifications

**Effort: M**

### Value proposition
Right now every point transaction is written to the ledger silently — a
customer earns points, gets a referral bonus, or hits a new VIP tier, and
finds out only if they happen to open the account page or storefront widget.
No competitor ships a loyalty program that never talks to the customer; this
is the single biggest gap between what the app does and what "loyalty
program" implies. It's also the most direct way to make members actually
come back and redeem, which is the whole point of the product.

### Expected behavior
Don't build an email sender from scratch. Target merchants already run
Klaviyo (dominant on Shopify) or Omnisend. Emit tracked events to the
merchant's connected ESP so they can build their own flows (welcome, points
earned, tier-up, referral bonus) — this is how Smile.io and LoyaltyLion do it
too. Fall back to a generic outbound webhook for merchants without Klaviyo.

Events to emit, at minimum:
- `Habit: Points Earned` — after a successful EARN transaction
- `Habit: Tier Upgraded` — when `resolveVipTier` returns a different tier
  than the customer's current one
- `Habit: Referral Sent` (to referrer) / `Habit: Referral Welcome Bonus` (to
  referee) — on successful `redeemReferralCode`
- `Habit: Points Redeemed` — after `finalizeRedemptionForOrder`

### Acceptance criteria
- [ ] Merchant can enter a Klaviyo private API key in Settings; key is stored
      encrypted, never logged, never returned to the client in loader data.
- [ ] Each event above fires exactly once per underlying ledger transaction
      (reuse the existing idempotency checks already in `ledger.server.ts` —
      don't fire on webhook redelivery of an already-processed order).
- [ ] A failed/slow notification call never blocks or fails the webhook
      response, and never rolls back the ledger write. Webhooks must still
      return fast (Shopify retries on timeout).
- [ ] If no ESP is connected, event calls are a safe no-op (logged at debug
      level, not thrown).
- [ ] Settings page shows connection status (connected / not connected) and
      lets the merchant disconnect.

### Technical considerations
- New file: `app/lib/notifications.server.ts` — `trackKlaviyoEvent(shop, eventName, customerEmail, properties)`, wraps Klaviyo's Events API.
- New `ShopSettings` fields: `klaviyoApiKey` (encrypted at rest), `klaviyoEnabled`.
- Call sites: `app/lib/ledger.server.ts` — `awardPointsForOrder`, `redeemReferralCode`, `finalizeRedemptionForOrder`; tier-change detection needs a before/after comparison, easiest added inside `awardPointsForOrder` where `nextTier` is already computed.
- Webhook handlers (`app/routes/webhooks.orders.paid.tsx`, `webhooks.refunds.create.tsx`) call these `ledger.server.ts` functions synchronously today — do NOT await the Klaviyo call inline in the request/response path. Either fire-and-forget with a caught promise, or (cleaner, more reliable) write to a simple outbox table and process it from a separate scheduled route — see the points-expiry item below, which needs the same "background job" infrastructure Habit doesn't have yet. Worth building that infra once and reusing it for both.
- Klaviyo API keys are per-merchant secrets — do not reuse the app's own env vars; this is genuinely sensitive data, review Prisma field-level encryption options (e.g. `prisma-field-encryption`) rather than storing it in plaintext.

---

## P0 — Referral fraud alerting

**Effort: S–M**

### Value proposition
Your own launch-plan research and current app-listing copy both promise
"alerts on abnormal code-creation volume" as part of referral fraud
protection. Right now only the soft cap (`maxActiveReferralCodesPerCustomer`)
is enforced — there's no detection or alerting for burst/velocity abuse. This
is currently a marketing claim without a matching feature, and it's the one
differentiator competitor research couldn't find any incumbent doing well —
worth actually shipping before it's a listing claim you can't back up in
review.

### Expected behavior
Detect abnormal referral-code creation or redemption velocity at the shop
level and surface it to the merchant so they can act (revoke codes).

### Acceptance criteria
- [ ] A rolling-window check (e.g. >N codes created shop-wide within 1 hour,
      N configurable, sane default) runs whenever a new code is created.
- [ ] When the threshold is crossed, a flag is recorded and a banner appears
      on the admin dashboard (`app/routes/app._index.tsx`) until dismissed/resolved.
- [ ] Merchant can revoke a specific referral code from the customer detail
      page — `ReferralCodeStatus.REVOKED` already exists in the schema but no
      UI currently sets it; add a "Revoke" action next to each code in
      `app/routes/app.customers.$id.tsx`.
- [ ] Threshold is configurable in Settings, not hardcoded.
- [ ] (Stretch) Alert is also pushed through the notification pipeline from
      the item above (email/Slack to the merchant), not just an in-app banner.

### Technical considerations
- `ReferralCode` already has `@@index([shop, createdAt])` in `prisma/schema.prisma` with a comment noting it's there specifically to support this — the query is cheap, just needs writing.
- New function in `app/lib/ledger.server.ts` or a new `app/lib/fraud.server.ts`: `checkReferralVelocity(shop)` — count codes where `createdAt >= now - windowMinutes`, compare to `ShopSettings.referralVelocityThreshold`.
- Call it inside `createReferralCode` after the code is created (real-time, no separate job needed for this one — unlike points expiry).
- Consider whether IP/device signal is available: `proxy.referral-code.tsx` and `checkout-api.points.tsx` run through Shopify's app proxy / checkout extension, both of which forward some request metadata — verify what's actually available (don't assume `X-Forwarded-For` is reliable through Shopify's proxy) before designing a per-IP check. Shop-level velocity is the safe, provable-today signal; treat IP-based detection as a v2 stretch, not a launch blocker.

---

## P1 — Points expiry

**Effort: M**

### Value proposition
The dashboard already surfaces "Outstanding liability" in dollars — a nice
touch most competitors don't bother with — but nothing ever reduces it.
Merchants evaluating loyalty apps commonly ask for a "use it or lose it"
option specifically to cap this liability, and right now there's no lever at
all.

### Expected behavior
Optional, per-shop expiry. Recommend the simpler **inactivity-based** model
over true FIFO lot-expiry (expire points earned on a specific date) — FIFO
lot tracking is a well-known hard problem and adds real complexity for
uncertain merchant value at this stage. Inactivity-based: if a member has had
no EARN or REDEEM activity for N days, expire their entire remaining balance.

### Acceptance criteria
- [ ] New setting `pointsExpiryDays` (nullable; null = never expire, this is
      the default — don't change behavior for existing merchants).
- [ ] New `PointTransactionType.EXPIRE` enum value.
- [ ] A scheduled process finds customers with no ledger activity in the last
      `pointsExpiryDays` and writes an `EXPIRE` transaction zeroing their
      balance, following the exact same transactional pattern already used in
      `reverseForRefund` (create the ledger row + decrement balance in one
      `prisma.$transaction`).
- [ ] The process is idempotent and safe to re-run (a customer already at 0
      balance is a no-op, not an error).
- [ ] Storefront widget and account extension show a warning when a member's
      balance is within 30 days of expiring (needs `pointsExpiryDays` +
      last-activity date surfaced through `getLoyaltySnapshot`).
- [ ] Explicitly document (in the settings UI copy) that this is
      inactivity-based, not earn-date-based — so merchants aren't surprised
      by the mechanics.

### Technical considerations
- **This needs new infrastructure** — Habit currently has no background job
  runner. The cleanest option given the stack (React Router + Prisma +
  Postgres) is a scheduled route hit by an external scheduler (Vercel Cron if
  hosted there, or any cron hitting an authenticated internal endpoint) —
  this same infra is needed for the notification outbox above, build it once.
- Computing "last activity" via `MAX(PointTransaction.createdAt)` per
  customer on every run is an unnecessary aggregate at scale — consider
  adding `Customer.lastActivityAt`, updated alongside the existing balance
  writes in `awardPointsForOrder` / `finalizeRedemptionForOrder`, so the
  expiry job can just query `lastActivityAt < cutoff` directly.
- Update `app/lib/loyalty.server.ts` (`toCard` / `getLoyaltySnapshot`) to
  include an `expiresInDays` or `expiryWarning` field once this exists.

---

## P1 — Merchant-facing impact reporting

**Effort: M**

### Value proposition
The dashboard (`app/routes/app._index.tsx`) currently shows raw operational
counts — members, points issued/redeemed, liability. None of that answers
the question a merchant evaluating (or renewing) a loyalty app actually asks:
"is this driving repeat purchases?" This is a stronger retention/renewal
argument than anything currently on the landing page.

### Expected behavior
Add a "Program impact" section to the dashboard showing at minimum a member
repeat-purchase rate, computed from data already on hand.

### Acceptance criteria
- [ ] New stat: percentage of members with `lifetimeOrders > 1` (repeat
      purchase rate among program members).
- [ ] New stat: points redeemed as a percentage of total member GMV
      (`lifetimeSpend` sum), giving merchants a sense of redemption cost as %
      of revenue.
- [ ] Follows the existing `s-clickable` stat-card pattern already used in
      the Performance section of `app._index.tsx`, for visual consistency.
- [ ] No new Shopify API scopes required — computable entirely from existing
      `Customer` fields already synced (`lifetimeSpend`, `lifetimeOrders`).

### Technical considerations
- Cheap to add to the existing `Promise.all` in the `app._index.tsx` loader
  — e.g. `db.customer.count({ where: { shop, lifetimeOrders: { gt: 1 } } })`
  alongside the existing `memberCount` query.
- True "member vs. non-member uplift" (the stronger claim) needs shop-wide
  order data Habit doesn't currently store — only orders tied to an existing
  `Customer` row are known. That requires periodically pulling total
  shop-level order count/AOV via Admin GraphQL, which is a heavier, separate
  sync job. Scope that as a v2 stretch; ship member-only stats first.

---

## P2 — Decide and document the VIP tier model

**Effort: XS (if keeping as-is) / L (if adding rolling windows)**

### Value proposition
`resolveVipTier` in `app/lib/ledger.server.ts` evaluates tiers against
`Customer.lifetimeSpend`/`lifetimeOrders`, which only ever increase — so a
member can never lose a tier once earned. That may well be the right call
("your tier never drops" is a real differentiator over competitors' rolling
12-month resets), but right now it's an implicit consequence of the data
model rather than a deliberate, communicated decision.

### Expected behavior
This is a decision item first, a build item second.

**Recommended path (low effort):** keep lifetime-only evaluation, make it
explicit. Add a line to the Tiers admin page and Settings confirming tiers
are lifetime-based and never expire, and consider surfacing this as an
explicit selling point in the app listing/landing page copy.

**Alternative (high effort, only if a specific merchant need justifies it):**
add a `tierEvaluationWindow` setting (`lifetime` | `rolling_12mo`).
`resolveVipTier` would need to accept a windowed spend/order figure computed
from `PointTransaction` rows filtered by date, rather than reading
`Customer.lifetimeSpend`/`lifetimeOrders` directly — a real schema/query
change, not a copy change.

### Acceptance criteria (recommended path)
- [ ] Copy added to `app/routes/app.tiers.tsx` and/or `app.settings.tsx`
      confirming lifetime-based, non-expiring tier evaluation.
- [ ] No code change to tier resolution logic.

### Technical considerations
- Don't build the rolling-window version speculatively — it's a meaningfully
  larger change (windowed aggregate queries replace simple field reads used
  in `awardPointsForOrder`, `syncCustomersFromShopify`, and
  `nextTierProgress`) and there's no signal yet that merchants want it.

---

## P2 — Paginate the customers list

**Effort: S**

### Value proposition
`app/routes/app.customers.tsx` caps results at `take: 50` with no pagination
controls. Harmless today, but it's a correctness bug that will surface
exactly when a merchant has enough loyalty members to be worth worrying
about — members past the 50th will silently disappear from the admin view.

### Expected behavior
Standard pagination on the members list, search unaffected.

### Acceptance criteria
- [ ] List paginates (cursor or offset-based) with Next/Previous controls.
- [ ] Search (`q` param) still searches the full member set, not just the
      current page.
- [ ] Page state lives in the URL, consistent with the existing
      `useSearchParams` pattern already used for search in this file, so
      back-button and bookmarking behave correctly.

### Technical considerations
- Self-contained change to `app/routes/app.customers.tsx` loader (add
  `cursor`/`skip` to the Prisma query, return `nextCursor`) and the table
  component (add pagination controls). No schema change needed.

---

## P2 — Sell the value prop to logged-out storefront visitors

**Effort: XS**

### Value proposition
The guest state in the points widget currently just says "Log in to see your
balance" — it doesn't tell a first-time visitor why they'd bother. Showing
the actual points they'd earn on what's in front of them is a stronger
conversion nudge into program signup.

### Expected behavior
For logged-out visitors, show an estimate of points earnable on the current
product/order, with a benefit-led CTA.

### Acceptance criteria
- [ ] Guest state in `extensions/points-widget/blocks/points_widget.liquid`
      computes and displays something like "Earn ~40 points on this order"
      using the existing `data-product-price-cents` attribute and the shop's
      `pointsPerDollar` rate.
- [ ] Login CTA copy changes from plain "Log in" to benefit-led (e.g. "Log in
      to start earning").

### Technical considerations
- Fully contained to `extensions/points-widget/assets/points-widget.js` and
  the guest block markup — `pointsPerDollar` is already returned by
  `proxy.balance.tsx` even for logged-out requests (`ratesPayload`), so no
  backend change is needed.

---

## Suggested build order

1. Referral fraud alerting (P0, smaller, no new infra, closes an active
   marketing-claim gap)
2. Customer lifecycle notifications (P0, larger, but build the background-job
   infra here since points expiry needs it too)
3. Points expiry (P1, reuses the infra from #2)
4. Merchant impact reporting (P1, no dependencies, can run in parallel with
   1–3)
5. Customers pagination + guest widget copy (P2, both trivial, good filler
   between the larger items)
6. VIP tier model — just write the copy (P2, unless a merchant complaint
   changes the calculus)
