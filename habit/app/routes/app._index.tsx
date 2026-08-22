import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/brand";

const THEME_EDITOR = "shopify://admin/themes/current/editor";
const CART_EMBED =
  "shopify://admin/themes/current/editor?context=apps&activateAppId=d4f4bcdc36a90b4443c2e6fde31bbd80/redeem_points_embed";
const CALLOUT_IMAGE = "/setup-callout.png";

type SetupStepData = {
  title: string;
  description: string;
  done: boolean;
  actionHref: string;
  actionLabel: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getOrCreateShopSettings(shop);

  const [memberCount, tierCount, pointTotals, liabilityAgg, repeatMembers, gmv] = await Promise.all([
    db.customer.count({ where: { shop } }),
    db.vipTier.count({ where: { shop } }),
    db.pointTransaction.groupBy({
      by: ["type"],
      where: { shop, type: { in: ["EARN", "REDEEM"] } },
      _sum: { points: true },
    }),
    db.customer.aggregate({ where: { shop }, _sum: { pointsBalance: true } }),
    db.customer.count({ where: { shop, lifetimeOrders: { gt: 1 } } }),
    db.customer.aggregate({ where: { shop }, _sum: { lifetimeSpend: true } }),
  ]);

  const pointsByType = Object.fromEntries(
    pointTotals.map((row) => [row.type, row._sum.points ?? 0]),
  );
  const pointsIssued = pointsByType.EARN ?? 0;
  const pointsRedeemed = Math.abs(pointsByType.REDEEM ?? 0);
  const memberGmv = Number(gmv._sum.lifetimeSpend ?? 0);
  const redeemedDollars = pointsRedeemed / (Number(settings.redemptionRate) || 1);

  const ratesReviewed =
    Number(settings.pointsPerDollar) !== 1 ||
    Number(settings.redemptionRate) !== 100 ||
    settings.updatedAt.getTime() - settings.createdAt.getTime() > 5000;

  const showVelocityAlert =
    settings.referralVelocityAlertAt != null &&
    (settings.referralVelocityDismissedAt == null ||
      settings.referralVelocityDismissedAt < settings.referralVelocityAlertAt);

  return {
    shop,
    onboardingDismissed: settings.onboardingDismissedAt != null,
    showVelocityAlert,
    hasCustomTiers: tierCount > 0,
    ratesReviewed,
    metrics: {
      memberCount,
      pointsIssued,
      pointsRedeemed,
      outstandingLiability: liabilityAgg._sum.pointsBalance ?? 0,
      repeatPurchaseRate: memberCount > 0 ? repeatMembers / memberCount : 0,
      redemptionOfGmv: memberGmv > 0 ? redeemedDollars / memberGmv : 0,
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

  if (formData.get("intent") === "dismiss-velocity-alert") {
    await db.shopSettings.update({
      where: { shop },
      data: { referralVelocityDismissedAt: new Date() },
    });
  }

  return null;
};

function isExternalAdminHref(href: string) {
  return href.startsWith("shopify://") || href.startsWith("http");
}

function StepAction({ href, label }: { href: string; label: string }) {
  if (isExternalAdminHref(href)) {
    return (
      <s-link href={href} target="_blank">
        {label}
      </s-link>
    );
  }

  return (
    <s-button variant="primary" href={href}>
      {label}
    </s-button>
  );
}

function SetupStep({
  step,
  expanded,
  onToggle,
}: {
  step: SetupStepData;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <s-box>
      <s-grid gridTemplateColumns="1fr auto" gap="base" padding="small" alignItems="center">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {step.done ? (
            <s-badge tone="success">Done</s-badge>
          ) : (
            <s-badge tone="info">To do</s-badge>
          )}
          <s-text type="strong">{step.title}</s-text>
        </s-stack>
        <s-button
          accessibilityLabel={`Toggle ${step.title}`}
          variant="tertiary"
          tone="neutral"
          icon={expanded ? "chevron-up" : "chevron-down"}
          onClick={onToggle}
        />
      </s-grid>
      <s-box padding="small" paddingBlockStart="none" display={expanded ? "auto" : "none"}>
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-paragraph>{step.description}</s-paragraph>
            {!step.done ? <StepAction href={step.actionHref} label={step.actionLabel} /> : null}
          </s-stack>
        </s-box>
      </s-box>
    </s-box>
  );
}

export default function Dashboard() {
  const { onboardingDismissed, showVelocityAlert, hasCustomTiers, ratesReviewed, metrics, settings } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const setupSteps: SetupStepData[] = [
    {
      title: "Review earn and redemption rates",
      description: "Confirm how many points members earn per dollar, and what those points are worth.",
      done: ratesReviewed,
      actionHref: "/app/settings",
      actionLabel: "Open settings",
    },
    {
      title: "Add the product widget",
      description:
        "Add it on product pages only — not the header. It shows balance, what this product earns, and a link to redeem in cart.",
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
      description:
        "Members appear after a paid order, or when someone opens the storefront widget while logged in.",
      done: metrics.memberCount > 0,
      actionHref: "/app/customers",
      actionLabel: "View members",
    },
  ];

  const completed = setupSteps.filter((step) => step.done).length;
  const firstIncomplete = setupSteps.findIndex((step) => !step.done);
  const [guideOpen, setGuideOpen] = useState(true);
  const [openStep, setOpenStep] = useState(firstIncomplete === -1 ? 0 : firstIncomplete);

  const dismissOnboarding = () => {
    fetcher.submit({ intent: "dismiss-onboarding" }, { method: "POST" });
  };

  const liabilityDollars = metrics.outstandingLiability / (settings.redemptionRate || 1);
  const sampleEarn = Math.floor(50 * settings.pointsPerDollar);
  const sampleValue = (sampleEarn / (settings.redemptionRate || 1)).toFixed(2);
  const nextStep = firstIncomplete === -1 ? null : setupSteps[firstIncomplete];
  const programLive = completed === setupSteps.length;

  return (
    <s-page>
      <s-button slot="primary-action" href="/app/customers">
        View members
      </s-button>
      <s-button slot="secondary-actions" href="/app/settings">
        Settings
      </s-button>

      {showVelocityAlert ? (
        <s-banner
          heading="Unusual referral activity"
          tone="warning"
          dismissible
          onDismiss={() =>
            fetcher.submit({ intent: "dismiss-velocity-alert" }, { method: "POST" })
          }
        >
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              Abnormal referral-code volume was detected. Review members and revoke
              codes that look fraudulent.
            </s-paragraph>
            <s-link href="/app/customers">Review members</s-link>
          </s-stack>
        </s-banner>
      ) : null}
      {!onboardingDismissed && (
        <s-section>
          <s-grid gridTemplateColumns="1fr auto" gap="small-400" alignItems="start">
            <s-grid
              gridTemplateColumns="@container (inline-size <= 480px) 1fr, auto auto"
              gap="base"
              alignItems="center"
            >
              <s-grid gap="small-200">
                <s-badge tone={programLive ? "success" : "info"}>
                  {programLive ? "Live" : "Setup"}
                </s-badge>
                <s-heading>
                  {programLive
                    ? "Your loyalty program is live"
                    : "Reward how customers actually buy"}
                </s-heading>
                <s-paragraph>
                  Points, VIP tiers, and referrals in one ledger. Members earn on purchase and
                  redeem at checkout.
                </s-paragraph>
                <s-stack direction="inline" gap="small-200">
                  {nextStep ? (
                    isExternalAdminHref(nextStep.actionHref) ? (
                      <s-link href={nextStep.actionHref} target="_blank">
                        {nextStep.actionLabel}
                      </s-link>
                    ) : (
                      <s-button variant="primary" href={nextStep.actionHref}>
                        {nextStep.actionLabel}
                      </s-button>
                    )
                  ) : (
                    <s-button variant="primary" href="/app/customers">
                      View members
                    </s-button>
                  )}
                  <s-button tone="neutral" variant="tertiary" href="/app/settings">
                    Review rates
                  </s-button>
                </s-stack>
              </s-grid>
              <s-stack alignItems="center">
                <s-box maxInlineSize="200px" borderRadius="base" overflow="hidden">
                  <s-image
                    src={CALLOUT_IMAGE}
                    alt="Abstract Habit loyalty mark"
                    aspectRatio="1/0.5"
                  />
                </s-box>
              </s-stack>
            </s-grid>
            <s-button
              icon="x"
              tone="neutral"
              variant="tertiary"
              accessibilityLabel="Dismiss setup card"
              onClick={dismissOnboarding}
            />
          </s-grid>
        </s-section>
      )}

      {!onboardingDismissed && (
        <s-section>
          <s-grid gap="small">
            <s-grid gap="small-200">
              <s-grid
                gridTemplateColumns="1fr auto auto"
                gap="small-300"
                alignItems="center"
              >
                <s-heading>Setup guide</s-heading>
                <s-button
                  accessibilityLabel="Dismiss setup guide"
                  variant="tertiary"
                  tone="neutral"
                  icon="x"
                  onClick={dismissOnboarding}
                />
                <s-button
                  accessibilityLabel="Toggle setup guide"
                  variant="tertiary"
                  tone="neutral"
                  icon={guideOpen ? "chevron-up" : "chevron-down"}
                  onClick={() => setGuideOpen((open) => !open)}
                />
              </s-grid>
              <s-paragraph color="subdued">
                {completed} of {setupSteps.length} steps complete
              </s-paragraph>
            </s-grid>
            <s-box
              borderRadius="base"
              border="base"
              background="base"
              display={guideOpen ? "auto" : "none"}
            >
              {setupSteps.map((step, index) => (
                <s-box key={step.title}>
                  {index > 0 ? <s-divider /> : null}
                  <SetupStep
                    step={step}
                    expanded={openStep === index}
                    onToggle={() => setOpenStep((current) => (current === index ? -1 : index))}
                  />
                </s-box>
              ))}
            </s-box>
          </s-grid>
        </s-section>
      )}

      <s-section padding="base">
        <s-grid gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
            <s-heading>Performance</s-heading>
            <s-link href="/app/customers">View members</s-link>
          </s-grid>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 400px) 1fr, 1fr auto 1fr auto 1fr"
            gap="small"
          >
            <s-clickable href="/app/settings" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">
              <s-grid gap="small-300">
                <s-heading>Outstanding liability</s-heading>
                <s-text>
                  $
                  {liabilityDollars.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </s-text>
                <s-text color="subdued">
                  {metrics.outstandingLiability.toLocaleString()} points at{" "}
                  {settings.redemptionRate} = $1
                </s-text>
              </s-grid>
            </s-clickable>
            <s-divider direction="block" />
            <s-clickable href="/app/customers" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">
              <s-grid gap="small-300">
                <s-heading>Members</s-heading>
                <s-text>{metrics.memberCount.toLocaleString()}</s-text>
                <s-text color="subdued">Balances on file</s-text>
              </s-grid>
            </s-clickable>
            <s-divider direction="block" />
            <s-clickable href="/app/customers" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">
              <s-grid gap="small-300">
                <s-heading>Points redeemed</s-heading>
                <s-text>{metrics.pointsRedeemed.toLocaleString()}</s-text>
                <s-text color="subdued">
                  {metrics.pointsIssued.toLocaleString()} issued
                </s-text>
              </s-grid>
            </s-clickable>
          </s-grid>
        </s-grid>
      </s-section>

      <s-section padding="base">
        <s-grid gap="base">
          <s-heading>Program impact</s-heading>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 400px) 1fr, 1fr auto 1fr"
            gap="small"
          >
            <s-clickable href="/app/customers" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">
              <s-grid gap="small-300">
                <s-heading>Repeat purchase rate</s-heading>
                <s-text>
                  {(metrics.repeatPurchaseRate * 100).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                  %
                </s-text>
                <s-text color="subdued">Members with more than one order</s-text>
              </s-grid>
            </s-clickable>
            <s-divider direction="block" />
            <s-clickable href="/app/customers" paddingBlock="small-400" paddingInline="small-100" borderRadius="base">
              <s-grid gap="small-300">
                <s-heading>Redemption of member GMV</s-heading>
                <s-text>
                  {(metrics.redemptionOfGmv * 100).toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                  %
                </s-text>
                <s-text color="subdued">
                  Discount value of redeemed points vs member lifetime spend
                </s-text>
              </s-grid>
            </s-clickable>
          </s-grid>
        </s-grid>
      </s-section>

      <s-section heading="How points work">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr auto"
          gap="base"
          alignItems="center"
        >
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              Members earn <s-text type="strong">{settings.pointsPerDollar}</s-text> point(s) per
              $1 spent. {settings.redemptionRate} points are worth $1 off.
            </s-paragraph>
            <s-paragraph color="subdued">
              A $50 order earns {sampleEarn} points (${sampleValue} off).
            </s-paragraph>
          </s-stack>
          <s-button href="/app/settings">Change rates</s-button>
        </s-grid>
      </s-section>

      <s-section heading="VIP tiers">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr auto"
          gap="base"
          alignItems="center"
        >
          <s-paragraph>
            Give repeat buyers a higher earn rate once they hit a spend or order threshold.
          </s-paragraph>
          <s-button href="/app/tiers" variant="secondary">
            {hasCustomTiers ? "Manage tiers" : "Add a tier"}
          </s-button>
        </s-grid>
      </s-section>

      <s-section heading="Storefront">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 480px) 1fr, 1fr auto"
          gap="base"
          alignItems="center"
        >
          <s-paragraph>
            Show balances on product pages only, and let members redeem from the
            cart drawer. Do not add the widget to the site header.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            <s-link href={THEME_EDITOR} target="_blank">
              Theme editor
            </s-link>
            <s-link href={CART_EMBED} target="_blank">
              Enable cart embed
            </s-link>
          </s-stack>
        </s-grid>
      </s-section>

      <s-section>
        <s-stack alignItems="center">
          <s-text>
            Need help? Email{" "}
            <s-link href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</s-link>.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
