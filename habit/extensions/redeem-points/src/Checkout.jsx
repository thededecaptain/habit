import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

// Must be a literal: the extension sandbox has no `process` global and the CLI
// does not substitute env vars, so reading process.env here throws before the
// extension can render. Update this if the app URL changes.
const APP_URL = "https://habit-production-9257.up.railway.app";

export default async () => {
  render(<Extension />, document.body);
};

// Points and referral codes are saved as cart attributes, not cart
// metafields: attributes always reach the order (where the orders/paid
// webhook reads them), while cart metafields only do with an order metafield
// definition — without one, points applied here were never deducted and
// referral codes never counted.
function attributeValue(key) {
  return shopify.attributes.value.find((a) => a.key === key)?.value;
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function EditorPreview() {
  return (
    <s-section heading="Redeem points">
      <s-stack direction="block" gap="base">
        <s-text type="strong">1,250 points · {money(12.5)} to spend</s-text>
        <s-text color="subdued">Preview — shown to logged-in customers with points.</s-text>
        <s-number-field label="Points to redeem" value="100" disabled />
        <s-text color="subdued">Up to 500 points ({money(5)}).</s-text>
        <s-button variant="primary" disabled>
          Apply points
        </s-button>
      </s-stack>
    </s-section>
  );
}

function GuestPanel({ referralCode, setReferralCode, referralStatus, onApplyReferral, canWrite, signedIn }) {
  return (
    <s-section heading="Rewards">
      <s-stack direction="block" gap="base">
        <s-banner tone={signedIn ? "warning" : "info"}>
          {signedIn
            ? "We couldn't load your points balance right now. Your points are safe — try again in a moment."
            : "Sign in to see your points balance and redeem them on this order."}
        </s-banner>
        <s-text color="subdued">
          Members earn points on every purchase and can apply them as a discount at checkout.
        </s-text>
        <s-details>
          <s-summary>Have a referral code?</s-summary>
          <s-stack direction="block" gap="small-200">
            <s-text-field
              label="Referral code"
              labelAccessibilityVisibility="exclusive"
              placeholder="Enter a code"
              value={referralCode}
              disabled={!canWrite}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                setReferralCode(typeof raw === "string" ? raw : "");
              }}
            />
            <s-button disabled={!canWrite} onClick={onApplyReferral}>
              Apply code
            </s-button>
            {referralStatus ? <s-text color="subdued">{referralStatus}</s-text> : null}
          </s-stack>
        </s-details>
      </s-stack>
    </s-section>
  );
}

function BalanceOnlyPanel({ points, balanceValue, reason }) {
  return (
    <s-section heading="Redeem points">
      <s-stack direction="block" gap="base">
        <s-text type="strong">
          {points.pointsBalance.toLocaleString()} points · {money(balanceValue)} to spend
        </s-text>
        <s-banner tone="info">{reason}</s-banner>
        <s-text color="subdued">
          Earn more on this order — points are added after payment.
        </s-text>
      </s-stack>
    </s-section>
  );
}

function Extension() {
  const inEditor = shopify.extension?.editor?.type === "checkout";
  const canWrite = shopify.instructions.value.attributes.canUpdateAttributes;
  const customer = shopify.buyerIdentity?.customer?.value;
  const subtotal = shopify.cost.subtotalAmount.value;

  const [loading, setLoading] = useState(true);
  const [points, setPoints] = useState(null);
  const [redeemInput, setRedeemInput] = useState(Number(attributeValue("points_to_redeem") ?? 0));
  const [applying, setApplying] = useState(false);
  const [referralCode, setReferralCode] = useState(attributeValue("referral_code") ?? "");
  const [referralStatus, setReferralStatus] = useState("");

  useEffect(() => {
    if (!customer?.id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(
          `${APP_URL}/checkout-api/points`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const data = await response.json();
        if (!cancelled) setPoints(data);
      } catch (error) {
        console.error("Failed to load points balance", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customer?.id]);

  const maxRedeemable = useMemo(() => {
    if (!points?.loggedIn) return 0;
    const byBalance = points.pointsBalance;
    const byPercent = points.maxRedemptionPercent
      ? Math.floor((subtotal.amount * (points.maxRedemptionPercent / 100)) * points.redemptionRate)
      : byBalance;
    return Math.max(0, Math.min(byBalance, byPercent));
  }, [points, subtotal.amount]);

  // Preview what will actually apply: Apply clamps to maxRedeemable too.
  const discountPreview = points ? Math.min(redeemInput, maxRedeemable) / points.redemptionRate : 0;
  const appliedPoints = Number(attributeValue("points_to_redeem") ?? 0);
  const balanceValue =
    points?.balanceValue != null
      ? points.balanceValue
      : points
        ? points.pointsBalance / points.redemptionRate
        : 0;

  async function applyRedemption() {
    if (!canWrite) return;
    setApplying(true);
    try {
      const clamped = Math.max(0, Math.min(redeemInput, maxRedeemable));
      await shopify.applyAttributeChange(
        clamped <= 0
          ? { type: "removeAttribute", key: "points_to_redeem" }
          : { type: "updateAttribute", key: "points_to_redeem", value: String(clamped) },
      );
    } finally {
      setApplying(false);
    }
  }

  async function applyReferralCode() {
    const code = referralCode.trim().toUpperCase();
    if (!canWrite || !code) return;
    setReferralStatus("Checking…");
    try {
      const token = await shopify.sessionToken.get();
      const response = await fetch(
        `${APP_URL}/checkout-api/referral-check?code=${encodeURIComponent(code)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await response.json();
      if (!data.valid) {
        setReferralStatus(data.error || "That code can't be used.");
        return;
      }
      const result = await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: "referral_code",
        value: data.code,
      });
      setReferralStatus(
        result.type === "error"
          ? "Couldn't save the code — try again."
          : `Code ${data.code} applied. You'll get ${Number(data.refereeBonusPoints || 0).toLocaleString()} bonus points after your order.`,
      );
    } catch (error) {
      console.error("Referral check failed", error);
      setReferralStatus("Couldn't check the code — try again.");
    }
  }

  // Always show something in the checkout editor so merchants/reviewers can place and verify the block.
  if (inEditor && (loading || !customer?.id || !points?.loggedIn)) {
    return <EditorPreview />;
  }

  if (loading) {
    return (
      <s-section heading="Redeem points">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="small" accessibilityLabel="Loading rewards" />
          <s-text color="subdued">Checking your rewards…</s-text>
        </s-stack>
      </s-section>
    );
  }

  // Guests, and signed-in buyers whose balance failed to load, still render
  // something (review requirement 5.6.1) plus the referral entry.
  if (!customer?.id || !points?.loggedIn) {
    return (
      <GuestPanel
        referralCode={referralCode}
        setReferralCode={setReferralCode}
        referralStatus={referralStatus}
        onApplyReferral={applyReferralCode}
        canWrite={canWrite}
        signedIn={Boolean(customer?.id)}
      />
    );
  }

  if (points.pointsBalance < points.minRedeemablePoints && appliedPoints <= 0) {
    return (
      <BalanceOnlyPanel
        points={points}
        balanceValue={balanceValue}
        reason={
          points.pointsBalance <= 0
            ? "You don't have points to redeem yet. Complete this order to start earning."
            : `You need at least ${points.minRedeemablePoints.toLocaleString()} points to redeem.`
        }
      />
    );
  }

  if (maxRedeemable <= 0 && appliedPoints <= 0) {
    return (
      <BalanceOnlyPanel
        points={points}
        balanceValue={balanceValue}
        reason="Points can't be applied to this order total right now."
      />
    );
  }

  return (
    <s-section heading="Redeem points">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">
            {points.pointsBalance.toLocaleString()} points · {money(balanceValue)} to spend
          </s-text>
          {appliedPoints > 0 ? (
            <s-text>
              Applied · {appliedPoints.toLocaleString()} points ({money(appliedPoints / points.redemptionRate)} off)
            </s-text>
          ) : (
            <s-text color="subdued">Discount is applied on this order.</s-text>
          )}
        </s-stack>

        <s-number-field
          label="Points to redeem"
          value={String(redeemInput)}
          min={0}
          max={maxRedeemable}
          step={points.minRedeemablePoints || 1}
          disabled={!canWrite}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            const next = raw === "" ? 0 : Number(raw);
            setRedeemInput(Number.isFinite(next) ? next : 0);
          }}
        />
        <s-text color="subdued">
          Up to {maxRedeemable.toLocaleString()} points ({money(maxRedeemable / points.redemptionRate)}).
        </s-text>

        <s-text>
          {redeemInput > 0
            ? `You’ll save ${money(discountPreview)}`
            : "Choose how many points to redeem."}
        </s-text>

        <s-button
          variant="primary"
          disabled={!canWrite || applying || redeemInput === appliedPoints}
          onClick={applyRedemption}
        >
          {appliedPoints > 0 ? "Update points" : "Apply points"}
        </s-button>

        <s-details>
          <s-summary>Have a referral code?</s-summary>
          <s-stack direction="block" gap="small-200">
            <s-text-field
              label="Referral code"
              labelAccessibilityVisibility="exclusive"
              placeholder="Enter a code"
              value={referralCode}
              disabled={!canWrite}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                setReferralCode(typeof raw === "string" ? raw : "");
              }}
            />
            <s-button disabled={!canWrite} onClick={applyReferralCode}>
              Apply code
            </s-button>
            {referralStatus ? <s-text color="subdued">{referralStatus}</s-text> : null}
          </s-stack>
        </s-details>
      </s-stack>
    </s-section>
  );
}
