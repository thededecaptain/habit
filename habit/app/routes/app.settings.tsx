import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { ensureRedemptionDiscount, syncLoyaltySettingsMetafield } from "../lib/discount.server";
import { isBillingTest } from "../lib/billing";

const SAVE_BAR_ID = "settings-save-bar";

type FormState = {
  pointsPerDollar: string;
  redemptionRate: string;
  minRedeemablePoints: string;
  maxRedemptionPercent: string;
  referrerBonusPoints: string;
  refereeBonusPoints: string;
  referralCodeExpiryDays: string;
  maxActiveReferralCodesPerCustomer: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest: isBillingTest(),
  });

  const values: FormState = {
    pointsPerDollar: String(settings.pointsPerDollar),
    redemptionRate: String(settings.redemptionRate),
    minRedeemablePoints: String(settings.minRedeemablePoints),
    maxRedemptionPercent: String(settings.maxRedemptionPercent),
    referrerBonusPoints: String(settings.referrerBonusPoints),
    refereeBonusPoints: String(settings.refereeBonusPoints),
    referralCodeExpiryDays: String(settings.referralCodeExpiryDays),
    maxActiveReferralCodesPerCustomer: String(settings.maxActiveReferralCodesPerCustomer),
  };

  const privacyRequests = await db.privacyRequest.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      type: true,
      shopifyCustomerId: true,
      status: true,
      createdAt: true,
      exportData: true,
    },
  });

  return {
    values,
    billing: {
      hasActivePayment,
      planName: appSubscriptions[0]?.name ?? MONTHLY_PLAN,
      subscriptionId: appSubscriptions[0]?.id ?? null,
    },
    privacyRequests: privacyRequests.map((row) => ({
      id: row.id,
      type: row.type,
      shopifyCustomerId: row.shopifyCustomerId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      hasExport: row.exportData != null,
    })),
  };
};

function parsePositiveNumber(value: FormDataEntryValue | null, label: string) {
  const num = Number(value);
  if (!value || Number.isNaN(num) || num <= 0) {
    return { error: `${label} must be a number greater than 0.` };
  }
  return { value: num };
}

function parsePositiveInt(value: FormDataEntryValue | null, label: string) {
  const num = Number(value);
  if (!value || !Number.isInteger(num) || num <= 0) {
    return { error: `${label} must be a whole number greater than 0.` };
  }
  return { value: num };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, billing, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "cancel-subscription") {
    const { appSubscriptions } = await billing.check({
      plans: [MONTHLY_PLAN],
      isTest: isBillingTest(),
    });
    const subscription = appSubscriptions[0];
    if (subscription) {
      await billing.cancel({
        subscriptionId: subscription.id,
        isTest: isBillingTest(),
        prorate: true,
      });
    }
    throw redirect("/app/plan");
  }

  const fields = {
    pointsPerDollar: parsePositiveNumber(formData.get("pointsPerDollar"), "Points per dollar"),
    redemptionRate: parsePositiveNumber(formData.get("redemptionRate"), "Redemption rate"),
    minRedeemablePoints: parsePositiveInt(
      formData.get("minRedeemablePoints"),
      "Minimum redeemable points",
    ),
    maxRedemptionPercent: parsePositiveNumber(
      formData.get("maxRedemptionPercent"),
      "Max redemption percent",
    ),
    referrerBonusPoints: parsePositiveInt(
      formData.get("referrerBonusPoints"),
      "Referrer bonus points",
    ),
    refereeBonusPoints: parsePositiveInt(
      formData.get("refereeBonusPoints"),
      "New customer bonus points",
    ),
    referralCodeExpiryDays: parsePositiveInt(
      formData.get("referralCodeExpiryDays"),
      "Referral code expiry",
    ),
    maxActiveReferralCodesPerCustomer: parsePositiveInt(
      formData.get("maxActiveReferralCodesPerCustomer"),
      "Max active referral codes",
    ),
  };

  const errors = Object.fromEntries(
    Object.entries(fields)
      .filter(([, result]) => "error" in result)
      .map(([key, result]) => [key, (result as { error: string }).error]),
  );

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  if (Number(fields.maxRedemptionPercent.value) > 100) {
    return { errors: { maxRedemptionPercent: "Max redemption percent can't exceed 100." } };
  }

  const updated = await db.shopSettings.update({
    where: { shop: session.shop },
    data: {
      pointsPerDollar: fields.pointsPerDollar.value,
      redemptionRate: fields.redemptionRate.value,
      minRedeemablePoints: fields.minRedeemablePoints.value,
      maxRedemptionPercent: fields.maxRedemptionPercent.value,
      referrerBonusPoints: fields.referrerBonusPoints.value,
      refereeBonusPoints: fields.refereeBonusPoints.value,
      referralCodeExpiryDays: fields.referralCodeExpiryDays.value,
      maxActiveReferralCodesPerCustomer: fields.maxActiveReferralCodesPerCustomer.value,
    },
  });

  await syncLoyaltySettingsMetafield(admin, session.shop, updated);
  await ensureRedemptionDiscount(admin, session.shop);

  return { errors: null, savedAt: Date.now() };
};

export default function Settings() {
  const { values, billing, privacyRequests } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [form, setForm] = useState<FormState>(values);
  // Bumped on discard to force the (uncontrolled) fields below to remount
  // with their defaultValue reset to the last-saved values.
  const [resetKey, setResetKey] = useState(0);
  // Tracks which fields the user has edited since the last save attempt, so
  // a stale validation error doesn't linger on a field after it's been fixed
  // (errors only actually clear once the next save response comes back).
  const [editedSinceSubmit, setEditedSinceSubmit] = useState<Set<string>>(new Set());
  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(values),
    [form, values],
  );
  const rawErrors = fetcher.data?.errors ?? {};
  const errors = Object.fromEntries(
    Object.entries(rawErrors).filter(([key]) => !editedSinceSubmit.has(key)),
  ) as typeof rawErrors;

  useEffect(() => {
    if (isDirty) {
      shopify.saveBar.show(SAVE_BAR_ID);
    } else {
      shopify.saveBar.hide(SAVE_BAR_ID);
    }
  }, [isDirty, shopify]);

  useEffect(() => {
    if (fetcher.data && !fetcher.data.errors) {
      shopify.saveBar.hide(SAVE_BAR_ID);
      shopify.toast.show("Settings saved");
      // Re-sync the uncontrolled fields to the canonical persisted values
      // (e.g. in case the server reformats a number) once the loader
      // revalidates with the freshly saved data.
      setResetKey((key) => key + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  // These fields are intentionally uncontrolled (defaultValue, not value):
  // Polaris's number/text field custom elements don't reliably accept
  // programmatic `value` updates from React re-renders, so feeding the typed
  // value back in as a controlled prop causes it to snap back to the last
  // internally-known value on blur. We only ever read from onInput (fires on
  // every keystroke), not onChange (only fires on blur, which can race with
  // a Save button click before React state catches up).
  const update = (key: keyof FormState) => (event: any) => {
    setForm((prev) => ({ ...prev, [key]: event.currentTarget?.value ?? "" }));
    setEditedSinceSubmit((prev) => new Set(prev).add(key));
  };

  const handleSave = () => {
    setEditedSinceSubmit(new Set());
    fetcher.submit(form, { method: "POST" });
  };

  const handleDiscard = () => {
    setForm(values);
    setEditedSinceSubmit(new Set());
    setResetKey((key) => key + 1);
  };

  return (
    <s-page heading="Settings">
      <s-section heading="Earning points">
        <s-stack direction="block" gap="base">
          <s-number-field
            key={`pointsPerDollar-${resetKey}`}
            label="Points earned per $1 spent"
            name="pointsPerDollar"
            defaultValue={values.pointsPerDollar}
            onInput={update("pointsPerDollar")}
            error={errors.pointsPerDollar}
            min={0}
            step={0.5}
            details="Applied to the order subtotal, before VIP tier multipliers."
          />
        </s-stack>
      </s-section>

      <s-section heading="Example on a $50 order">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Earns{" "}
            <s-text type="strong">
              {Math.floor(50 * (Number(form.pointsPerDollar) || 0)).toLocaleString()} points
            </s-text>
            .
          </s-paragraph>
          <s-paragraph>
            Those points are worth{" "}
            <s-text type="strong">
              $
              {(
                Math.floor(50 * (Number(form.pointsPerDollar) || 0)) /
                (Number(form.redemptionRate) || 1)
              ).toFixed(2)}
            </s-text>{" "}
            off.
          </s-paragraph>
          <s-paragraph color="subdued">
            Redemption is capped at {form.maxRedemptionPercent || 0}% of the order (
            ${((50 * (Number(form.maxRedemptionPercent) || 0)) / 100).toFixed(2)} on this example),
            and at least {form.minRedeemablePoints || 0} points.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Redeeming points">
        <s-stack direction="block" gap="base">
          <s-number-field
            key={`redemptionRate-${resetKey}`}
            label="Points needed for $1 off"
            name="redemptionRate"
            defaultValue={values.redemptionRate}
            onInput={update("redemptionRate")}
            error={errors.redemptionRate}
            min={0}
          />
          <s-number-field
            key={`minRedeemablePoints-${resetKey}`}
            label="Minimum points to redeem"
            name="minRedeemablePoints"
            defaultValue={values.minRedeemablePoints}
            onInput={update("minRedeemablePoints")}
            error={errors.minRedeemablePoints}
            min={0}
            step={1}
          />
          <s-number-field
            key={`maxRedemptionPercent-${resetKey}`}
            label="Max % of order payable with points"
            name="maxRedemptionPercent"
            defaultValue={values.maxRedemptionPercent}
            onInput={update("maxRedemptionPercent")}
            error={errors.maxRedemptionPercent}
            min={0}
            max={100}
            details="Caps how much of the order subtotal can be covered by point redemption."
          />
        </s-stack>
      </s-section>

      <s-section heading="Referrals">
        <s-stack direction="block" gap="base">
          <s-number-field
            key={`referrerBonusPoints-${resetKey}`}
            label="Bonus points for the referrer"
            name="referrerBonusPoints"
            defaultValue={values.referrerBonusPoints}
            onInput={update("referrerBonusPoints")}
            error={errors.referrerBonusPoints}
            min={0}
            step={1}
          />
          <s-number-field
            key={`refereeBonusPoints-${resetKey}`}
            label="Bonus points for the new customer"
            name="refereeBonusPoints"
            defaultValue={values.refereeBonusPoints}
            onInput={update("refereeBonusPoints")}
            error={errors.refereeBonusPoints}
            min={0}
            step={1}
          />
          <s-number-field
            key={`referralCodeExpiryDays-${resetKey}`}
            label="Referral code expiry (days)"
            name="referralCodeExpiryDays"
            defaultValue={values.referralCodeExpiryDays}
            onInput={update("referralCodeExpiryDays")}
            error={errors.referralCodeExpiryDays}
            min={1}
            step={1}
          />
          <s-number-field
            key={`maxActiveReferralCodesPerCustomer-${resetKey}`}
            label="Max active referral codes per member"
            name="maxActiveReferralCodesPerCustomer"
            defaultValue={values.maxActiveReferralCodesPerCustomer}
            onInput={update("maxActiveReferralCodesPerCustomer")}
            error={errors.maxActiveReferralCodesPerCustomer}
            min={1}
            step={1}
            details="Basic fraud protection: caps how many unused codes a member can generate."
          />
        </s-stack>
      </s-section>

      <s-section heading="Billing">
        <s-stack direction="block" gap="base">
          {billing.hasActivePayment ? (
            <>
              <s-paragraph>
                Current plan: <s-text type="strong">{billing.planName}</s-text>. Canceling stops
                future Shopify charges immediately (unused time is prorated). The app stays
                installed until you uninstall it from Shopify; you can resubscribe anytime.
              </s-paragraph>
              <s-button
                tone="critical"
                variant="secondary"
                onClick={() =>
                  fetcher.submit({ intent: "cancel-subscription" }, { method: "POST" })
                }
              >
                Cancel subscription
              </s-button>
            </>
          ) : (
            <s-paragraph>
              No active subscription.{" "}
              <s-link href="/app/plan">Start the Habit monthly plan</s-link>.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Privacy requests">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            GDPR customer data requests are saved here so you can download the export and send
            it to the customer.{" "}
            <s-link href="/privacy" target="_blank">
              Privacy policy
            </s-link>
          </s-paragraph>
          {privacyRequests.length === 0 ? (
            <s-paragraph color="subdued">No privacy webhooks received yet.</s-paragraph>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header>Type</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Received</s-table-header>
                <s-table-header>Export</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {privacyRequests.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>{row.type}</s-table-cell>
                    <s-table-cell>{row.shopifyCustomerId ?? "—"}</s-table-cell>
                    <s-table-cell>{row.status}</s-table-cell>
                    <s-table-cell>{new Date(row.createdAt).toLocaleString()}</s-table-cell>
                    <s-table-cell>
                      {row.hasExport ? (
                        <s-link href={`/app/privacy/${row.id}`} target="_blank">
                          Download JSON
                        </s-link>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <ui-save-bar id={SAVE_BAR_ID}>
        <button variant="primary" onClick={handleSave}>
          Save
        </button>
        <button onClick={handleDiscard}>Discard</button>
      </ui-save-bar>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
