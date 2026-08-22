import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/ledger.server";
import { ensureRedemptionDiscount, syncLoyaltySettingsMetafield } from "../lib/discount.server";
import {
  STANDARD_PLAN_AMOUNT,
  STANDARD_PLAN_TRIAL_DAYS,
  clearAppPricingGrant,
  findPaidAccess,
  loadShopBillingContext,
  redirectToSubscribe,
  shouldUseTestCharges,
} from "../lib/billing.server";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/brand";
import { EncryptionConfigError, encryptSecret } from "../lib/secrets.server";

// Keep these names in the route so the settings UI can list them without
// importing a .server module (React Router would otherwise fail the client bundle).
const KLAVIYO_METRIC_NAMES = [
  "Habit: Points Earned",
  "Habit: Tier Upgraded",
  "Habit: Referral Sent",
  "Habit: Referral Welcome Bonus",
  "Habit: Points Redeemed",
  "Habit: Points Expiring Soon",
  "Habit: Points Expired",
] as const;

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
  referralVelocityThreshold: string;
  referralVelocityWindowMinutes: string;
  pointsExpiryDays: string;
  notificationWebhookUrl: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);
  const shopContext = await loadShopBillingContext(admin, session.shop);
  const access = await findPaidAccess(billing, shopContext, admin);

  const values: FormState = {
    pointsPerDollar: String(settings.pointsPerDollar),
    redemptionRate: String(settings.redemptionRate),
    minRedeemablePoints: String(settings.minRedeemablePoints),
    maxRedemptionPercent: String(settings.maxRedemptionPercent),
    referrerBonusPoints: String(settings.referrerBonusPoints),
    refereeBonusPoints: String(settings.refereeBonusPoints),
    referralCodeExpiryDays: String(settings.referralCodeExpiryDays),
    maxActiveReferralCodesPerCustomer: String(settings.maxActiveReferralCodesPerCustomer),
    referralVelocityThreshold: String(settings.referralVelocityThreshold),
    referralVelocityWindowMinutes: String(settings.referralVelocityWindowMinutes),
    pointsExpiryDays: settings.pointsExpiryDays != null ? String(settings.pointsExpiryDays) : "",
    notificationWebhookUrl: settings.notificationWebhookUrl ?? "",
  };

  return {
    values,
    klaviyoConnected: Boolean(settings.klaviyoEnabled && settings.klaviyoApiKeyEncrypted),
    amount: STANDARD_PLAN_AMOUNT,
    trialDays: STANDARD_PLAN_TRIAL_DAYS,
    subscription: access
      ? {
          source: access.source,
          status: access.status,
          inTrial: access.inTrial,
          trialEndsAt: access.trialEndsAt,
          currentPeriodEnd: access.currentPeriodEnd,
        }
      : null,
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

function parseOptionalPositiveInt(value: FormDataEntryValue | null, label: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null as number | null };
  return parsePositiveInt(value, label);
}

function parseOptionalHttpsUrl(value: FormDataEntryValue | null, label: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null as string | null };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      return { error: `${label} must be an https URL.` };
    }
    return { value: raw };
  } catch {
    return { error: `${label} must be a valid URL.` };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, billing, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "cancel-subscription") {
    const shopContext = await loadShopBillingContext(admin, session.shop);
    const access = await findPaidAccess(billing, shopContext, admin);
    await clearAppPricingGrant(session.shop);
    if (access?.billingSubscriptionId) {
      const isTest = await shouldUseTestCharges(admin);
      try {
        await billing.cancel({
          subscriptionId: access.billingSubscriptionId,
          isTest,
          prorate: true,
        });
      } catch {
        // Already cancelled or test/live mismatch — still leave Settings.
      }
    }
    // Leave the iframe. A same-frame redirect unmounts s-modal while its
    // nodes live on document.body and React throws removeChild.
    throw await redirectToSubscribe(redirect, session.shop, shopContext);
  }

  if (formData.get("intent") === "connect-klaviyo") {
    const key = String(formData.get("klaviyoApiKey") ?? "").trim();
    if (!key) {
      return { errors: { klaviyoApiKey: "Enter a Klaviyo private API key." } };
    }
    try {
      const encrypted = encryptSecret(key);
      await db.shopSettings.update({
        where: { shop: session.shop },
        data: { klaviyoApiKeyEncrypted: encrypted, klaviyoEnabled: true },
      });
    } catch (error) {
      if (error instanceof EncryptionConfigError) {
        return {
          errors: {
            klaviyoApiKey:
              "Habit isn't configured to store API keys yet. Contact support.",
          },
        };
      }
      throw error;
    }
    return { errors: null, klaviyoSaved: true, klaviyoConnected: true };
  }

  if (formData.get("intent") === "disconnect-klaviyo") {
    await db.shopSettings.update({
      where: { shop: session.shop },
      data: { klaviyoApiKeyEncrypted: null, klaviyoEnabled: false },
    });
    return { errors: null, klaviyoSaved: true, klaviyoConnected: false };
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
    referralVelocityThreshold: parsePositiveInt(
      formData.get("referralVelocityThreshold"),
      "Referral velocity threshold",
    ),
    referralVelocityWindowMinutes: parsePositiveInt(
      formData.get("referralVelocityWindowMinutes"),
      "Referral velocity window",
    ),
    pointsExpiryDays: parseOptionalPositiveInt(
      formData.get("pointsExpiryDays"),
      "Points expiry",
    ),
    notificationWebhookUrl: parseOptionalHttpsUrl(
      formData.get("notificationWebhookUrl"),
      "Notification webhook URL",
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
      referralVelocityThreshold: fields.referralVelocityThreshold.value,
      referralVelocityWindowMinutes: fields.referralVelocityWindowMinutes.value,
      pointsExpiryDays: fields.pointsExpiryDays.value,
      notificationWebhookUrl: fields.notificationWebhookUrl.value,
    },
  });

  await syncLoyaltySettingsMetafield(admin, session.shop, updated);
  await ensureRedemptionDiscount(admin, session.shop);

  return { errors: null, savedAt: Date.now() };
};

export default function Settings() {
  const { values, klaviyoConnected, amount, trialDays, subscription } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const billingFetcher = useFetcher();
  const notifyFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const klaviyoKeyRef = useRef("");

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
  const klaviyoError =
    notifyFetcher.data && notifyFetcher.data.errors
      ? notifyFetcher.data.errors.klaviyoApiKey
      : undefined;
  const notifyBusy = notifyFetcher.state !== "idle";

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

  useEffect(() => {
    if (notifyFetcher.data && !notifyFetcher.data.errors) {
      shopify.toast.show(
        notifyFetcher.data.klaviyoConnected ? "Klaviyo connected" : "Klaviyo disconnected",
      );
      klaviyoKeyRef.current = "";
      setResetKey((key) => key + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyFetcher.data]);
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

  const cancelling = billingFetcher.state !== "idle";
  const inTrial = Boolean(subscription?.inTrial);

  return (
    <s-page heading="Settings">
      <s-section heading="Billing">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">Standard · ${amount}/month</s-text>
            {subscription ? (
              <s-badge tone={inTrial ? "info" : "success"}>
                {inTrial ? "Trial" : "Active"}
              </s-badge>
            ) : (
              <s-badge tone="warning">Inactive</s-badge>
            )}
          </s-stack>
          {subscription ? (
            <s-paragraph color="subdued">
              {inTrial && subscription.trialEndsAt
                ? `Trial ends ${new Date(subscription.trialEndsAt).toLocaleDateString()}. Then $${amount}/month.`
                : subscription.currentPeriodEnd
                  ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}.`
                  : `$${amount} billed every 30 days.`}
            </s-paragraph>
          ) : (
            <s-paragraph color="subdued">
              Start a {trialDays}-day free trial to keep Habit running.
            </s-paragraph>
          )}
          {subscription ? (
            <s-button
              tone="critical"
              commandFor="cancel-subscription-modal"
              command="--show"
            >
              Cancel subscription
            </s-button>
          ) : (
            <s-button variant="primary" href="/app/billing">
              Start free trial
            </s-button>
          )}
          <s-modal
            id="cancel-subscription-modal"
            heading="Cancel Habit?"
            accessibilityLabel="Cancel Habit subscription"
          >
            <s-paragraph>
              Billing stops immediately. Unused time in the current period is
              credited. You can start a new trial later from this app.
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              variant="secondary"
              commandFor="cancel-subscription-modal"
              command="--hide"
            >
              Keep subscription
            </s-button>
            <s-button
              slot="primary-action"
              variant="primary"
              tone="critical"
              loading={cancelling}
              commandFor="cancel-subscription-modal"
              command="--hide"
              onClick={() =>
                billingFetcher.submit(
                  { intent: "cancel-subscription" },
                  { method: "POST" },
                )
              }
            >
              Cancel subscription
            </s-button>
          </s-modal>
        </s-stack>
      </s-section>

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
          <s-paragraph color="subdued">
            VIP tiers are based on lifetime spend and orders and never drop.
          </s-paragraph>
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
          <s-number-field
            key={`referralVelocityThreshold-${resetKey}`}
            label="Alert after this many codes shop-wide"
            name="referralVelocityThreshold"
            defaultValue={values.referralVelocityThreshold}
            onInput={update("referralVelocityThreshold")}
            error={errors.referralVelocityThreshold}
            min={1}
            step={1}
            details="Triggers a dashboard banner when this many referral codes are created in the window below."
          />
          <s-number-field
            key={`referralVelocityWindowMinutes-${resetKey}`}
            label="Velocity window (minutes)"
            name="referralVelocityWindowMinutes"
            defaultValue={values.referralVelocityWindowMinutes}
            onInput={update("referralVelocityWindowMinutes")}
            error={errors.referralVelocityWindowMinutes}
            min={1}
            step={1}
            details="Rolling time window for the shop-wide code-creation alert above."
          />
        </s-stack>
      </s-section>

      <s-section heading="Points expiry">
        <s-stack direction="block" gap="base">
          <s-number-field
            key={`pointsExpiryDays-${resetKey}`}
            label="Expire unused points after (days)"
            name="pointsExpiryDays"
            defaultValue={values.pointsExpiryDays}
            onInput={update("pointsExpiryDays")}
            error={errors.pointsExpiryDays}
            min={1}
            step={1}
            details="Leave blank to never expire. Inactivity is measured from the member's last earn-on-order or redemption — referral bonuses and manual adjustments do not reset the clock. This is not earn-date FIFO: the whole balance expires together."
          />
        </s-stack>
      </s-section>

      <s-section heading="Notifications">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">Klaviyo</s-text>
            {klaviyoConnected ? (
              <s-badge tone="success">Connected</s-badge>
            ) : (
              <s-badge tone="warning">Not connected</s-badge>
            )}
          </s-stack>
          <s-paragraph color="subdued">
            Build flows in Klaviyo from these metrics. The private API key needs events:write.
            If the server encryption key is rotated, reconnect Klaviyo here — stored keys cannot
            be decrypted with a new key. Webhook URLs are unaffected.
          </s-paragraph>
          <s-unordered-list>
            {KLAVIYO_METRIC_NAMES.map((name) => (
              <s-list-item key={name}>{name}</s-list-item>
            ))}
          </s-unordered-list>
          <s-password-field
            key={`klaviyoApiKey-${resetKey}`}
            label="Klaviyo private API key"
            name="klaviyoApiKey"
            autocomplete="off"
            error={klaviyoError}
            details="Leave empty except to set or replace the key. The key is never shown again."
            onInput={(event: { currentTarget?: { value?: string } }) => {
              klaviyoKeyRef.current = event.currentTarget?.value ?? "";
            }}
          />
          <s-stack direction="inline" gap="small-200">
            <s-button
              variant="primary"
              loading={notifyBusy}
              onClick={() =>
                notifyFetcher.submit(
                  { intent: "connect-klaviyo", klaviyoApiKey: klaviyoKeyRef.current },
                  { method: "POST" },
                )
              }
            >
              {klaviyoConnected ? "Replace key" : "Connect Klaviyo"}
            </s-button>
            {klaviyoConnected ? (
              <s-button
                tone="critical"
                loading={notifyBusy}
                onClick={() =>
                  notifyFetcher.submit({ intent: "disconnect-klaviyo" }, { method: "POST" })
                }
              >
                Disconnect
              </s-button>
            ) : null}
          </s-stack>
          <s-url-field
            key={`notificationWebhookUrl-${resetKey}`}
            label="Optional notification webhook URL"
            name="notificationWebhookUrl"
            defaultValue={values.notificationWebhookUrl}
            onInput={update("notificationWebhookUrl")}
            error={errors.notificationWebhookUrl}
            details="Used only when Klaviyo is not connected. Habit POSTs JSON with eventName, customerEmail, and properties."
          />
        </s-stack>
      </s-section>

      <s-section>
        <s-stack alignItems="center">
          <s-text>
            Need help? Email{" "}
            <s-link href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</s-link>.
          </s-text>
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
