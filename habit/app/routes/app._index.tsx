import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";

const THEME_EDITOR = "shopify://admin/themes/current/editor";
const CART_EMBED =
  "shopify://admin/themes/current/editor?context=apps&activateAppId=3acb5c90ed6b779288c26dee2a0bf291/redeem_points_embed";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getOrCreateShopSettings(shop);

  const [memberCount, tierCount, earnAgg, redeemAgg, referralAgg, activeCodeCount, liabilityAgg] =
    await Promise.all([
      db.customer.count({ where: { shop } }),
      db.vipTier.count({ where: { shop } }),
      db.pointTransaction.aggregate({
        where: { shop, type: "EARN" },
        _sum: { points: true },
      }),
      db.pointTransaction.aggregate({
        where: { shop, type: "REDEEM" },
        _sum: { points: true },
      }),
      db.pointTransaction.aggregate({
        where: { shop, type: "REFERRAL_BONUS" },
        _sum: { points: true },
      }),
      db.referralCode.count({ where: { shop, status: "ACTIVE" } }),
      db.customer.aggregate({ where: { shop }, _sum: { pointsBalance: true } }),
    ]);

  const ratesReviewed =
    Number(settings.pointsPerDollar) !== 1 ||
    Number(settings.redemptionRate) !== 100 ||
    settings.updatedAt.getTime() - settings.createdAt.getTime() > 5000;

  return {
    shop,
    onboardingDismissed: settings.onboardingDismissedAt != null,
    hasCustomTiers: tierCount > 0,
    ratesReviewed,
    metrics: {
      memberCount,
      pointsIssued: earnAgg._sum.points ?? 0,
      pointsRedeemed: Math.abs(redeemAgg._sum.points ?? 0),
      referralPointsAwarded: referralAgg._sum.points ?? 0,
      activeReferralCodes: activeCodeCount,
      outstandingLiability: liabilityAgg._sum.pointsBalance ?? 0,
    },
    settings: {
      pointsPerDollar: Number(settings.pointsPerDollar),
      redemptionRate: Number(settings.redemptionRate),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  if (formData.get("intent") === "dismiss-onboarding") {
    await db.shopSettings.update({
      where: { shop },
      data: { onboardingDismissedAt: new Date() },
    });
  }

  return null;
};

function MetricCard({ label, value, helpText }: { label: string; value: string; helpText?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {helpText ? <s-text color="subdued">{helpText}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

function SetupStep({
  title,
  description,
  done,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  done: boolean;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <s-box padding="small" borderWidth="base" borderRadius="base">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">{title}</s-text>
          <s-paragraph color="subdued">{description}</s-paragraph>
        </s-stack>
        {done ? (
          <s-badge tone="success">Done</s-badge>
        ) : actionHref && (actionHref.startsWith("shopify://") || actionHref.startsWith("http")) ? (
          <s-link href={actionHref} target="_blank">
            {actionLabel}
          </s-link>
        ) : actionHref ? (
          <s-link href={actionHref}>{actionLabel}</s-link>
        ) : null}
      </s-grid>
    </s-box>
  );
}

export default function Dashboard() {
  const { onboardingDismissed, hasCustomTiers, ratesReviewed, metrics, settings } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const dismissOnboarding = () => {
    fetcher.submit({ intent: "dismiss-onboarding" }, { method: "POST" });
  };

  const setupSteps = [
    {
      title: "Review earn and redemption rates",
      description: "Confirm how many points members earn per dollar, and what those points are worth.",
      done: ratesReviewed,
      actionHref: "/app/settings",
      actionLabel: "Open settings",
    },
    {
      title: "Add the product widget",
      description: "Shows balance, what this product earns, and a link to redeem in cart.",
      done: false,
      actionHref: THEME_EDITOR,
      actionLabel: "Open theme editor",
    },
    {
      title: "Turn on Redeem points in cart",
      description: "Lets members apply points from the cart drawer — the primary path for non-Plus stores.",
      done: false,
      actionHref: CART_EMBED,
      actionLabel: "Enable app embed",
    },
    {
      title: "Optionally add VIP tiers",
      description: "Reward repeat buyers with a higher earn rate.",
      done: hasCustomTiers,
      actionHref: "/app/tiers",
      actionLabel: "Manage tiers",
    },
    {
      title: "Get a first member",
      description: "Members appear after a paid order, or when someone opens the storefront widget while logged in.",
      done: metrics.memberCount > 0,
      actionHref: "/app/customers",
      actionLabel: "View members",
    },
  ];
  const completed = setupSteps.filter((step) => step.done).length;
  const liabilityDollars = metrics.outstandingLiability / (settings.redemptionRate || 1);

  return (
    <s-page heading="Habit">
      {!onboardingDismissed && (
        <s-section>
          <s-grid gap="base">
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-heading>Set up Habit</s-heading>
              <s-button variant="tertiary" onClick={dismissOnboarding}>
                Dismiss
              </s-button>
            </s-grid>
            <s-paragraph color="subdued">
              {completed} of {setupSteps.length} steps complete
            </s-paragraph>
            {setupSteps.map((step) => (
              <SetupStep key={step.title} {...step} />
            ))}
          </s-grid>
        </s-section>
      )}

      <s-section heading="Outstanding liability">
        <s-stack direction="block" gap="small-200">
          <s-heading>
            $
            {liabilityDollars.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </s-heading>
          <s-paragraph>
            {metrics.outstandingLiability.toLocaleString()} points on member accounts, at{" "}
            {settings.redemptionRate} points = $1.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Program overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <MetricCard label="Members" value={metrics.memberCount.toLocaleString()} />
          <MetricCard
            label="Points issued"
            value={metrics.pointsIssued.toLocaleString()}
            helpText="Purchases + referral bonuses"
          />
          <MetricCard label="Points redeemed" value={metrics.pointsRedeemed.toLocaleString()} />
          <MetricCard
            label="Active referral codes"
            value={metrics.activeReferralCodes.toLocaleString()}
          />
        </s-grid>
      </s-section>

      <s-section heading="How points work right now" slot="aside">
        <s-paragraph>
          Members earn <s-text type="strong">{settings.pointsPerDollar}</s-text> point(s) per $1
          spent. {settings.redemptionRate} points are worth $1 off.
        </s-paragraph>
        <s-paragraph color="subdued">
          A $50 order earns {Math.floor(50 * settings.pointsPerDollar)} points (
          $
          {(Math.floor(50 * settings.pointsPerDollar) / (settings.redemptionRate || 1)).toFixed(2)}{" "}
          off).
        </s-paragraph>
        <s-link href="/app/settings">Change these rates</s-link>
      </s-section>

      <s-section heading="Manage your program" slot="aside">
        <s-stack direction="block" gap="small-200">
          <s-link href="/app/customers">View members</s-link>
          <s-link href="/app/tiers">Manage VIP tiers</s-link>
          <s-link href="/app/settings">Program settings</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
