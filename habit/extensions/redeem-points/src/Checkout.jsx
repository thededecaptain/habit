import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

const APP_URL = process.env.SHOPIFY_APP_URL;

export default async () => {
  render(<Extension />, document.body);
};

function metafieldValue(namespace, key) {
  return shopify.appMetafields.value.find(
    (m) => m.target.type === "cart" && m.metafield.namespace === namespace && m.metafield.key === key,
  )?.metafield?.value;
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

function Extension() {
  const inEditor = shopify.extension?.editor?.type === "checkout";
  const canSetMetafields = shopify.instructions.value.metafields.canSetCartMetafields;
  const customer = shopify.buyerIdentity?.customer?.value;
  const subtotal = shopify.cost.subtotalAmount.value;

  const [loading, setLoading] = useState(true);
  const [points, setPoints] = useState(null);
  const [redeemInput, setRedeemInput] = useState(
    Number(metafieldValue("$app", "points_to_redeem") ?? 0),
  );
  const [applying, setApplying] = useState(false);
  const [referralCode, setReferralCode] = useState(metafieldValue("$app", "referral_code") ?? "");
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
          `${APP_URL}/checkout-api/points?customerId=${encodeURIComponent(customer.id)}`,
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

  const discountPreview = points ? redeemInput / points.redemptionRate : 0;
  const appliedPoints = Number(metafieldValue("$app", "points_to_redeem") ?? 0);
  const balanceValue =
    points?.balanceValue != null
      ? points.balanceValue
      : points
        ? points.pointsBalance / points.redemptionRate
        : 0;

  if (!canSetMetafields && !inEditor) {
    return null;
  }

  if (inEditor && (loading || !customer?.id || !points?.loggedIn)) {
    return <EditorPreview />;
  }

  if (loading) {
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-spinner size="small" accessibilityLabel="Loading rewards" />
        <s-text color="subdued">Checking your rewards…</s-text>
      </s-stack>
    );
  }

  if (!customer?.id || !points?.loggedIn) {
    return inEditor ? <EditorPreview /> : null;
  }

  if (points.pointsBalance < points.minRedeemablePoints && appliedPoints <= 0) {
    return inEditor ? <EditorPreview /> : null;
  }

  async function applyRedemption() {
    setApplying(true);
    try {
      const clamped = Math.max(0, Math.min(redeemInput, maxRedeemable));
      if (clamped <= 0) {
        await shopify.applyMetafieldChange({ type: "removeCartMetafield", namespace: "$app", key: "points_to_redeem" });
      } else {
        await shopify.applyMetafieldChange({
          type: "updateCartMetafield",
          metafield: {
            namespace: "$app",
            key: "points_to_redeem",
            type: "number_integer",
            value: String(clamped),
          },
        });
      }
    } finally {
      setApplying(false);
    }
  }

  async function applyReferralCode() {
    if (!referralCode.trim()) return;
    setReferralStatus("Saving…");
    const result = await shopify.applyMetafieldChange({
      type: "updateCartMetafield",
      metafield: {
        namespace: "$app",
        key: "referral_code",
        type: "single_line_text_field",
        value: referralCode.trim().toUpperCase(),
      },
    });
    setReferralStatus(result.type === "error" ? "Couldn't save the code — try again." : "Applied. Verified after checkout.");
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
          onChange={(e) => {
            const next = Number(e.currentTarget.value);
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
          disabled={applying || redeemInput === appliedPoints}
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
              onChange={(e) => {
                const next = e.currentTarget.value;
                setReferralCode(typeof next === "string" ? next : "");
              }}
            />
            <s-button onClick={applyReferralCode}>Apply code</s-button>
            {referralStatus ? <s-text color="subdued">{referralStatus}</s-text> : null}
          </s-stack>
        </s-details>
      </s-stack>
    </s-section>
  );
}
