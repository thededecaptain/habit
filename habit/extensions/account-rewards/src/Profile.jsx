import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const APP_URL = process.env.SHOPIFY_APP_URL;

const TYPE_LABELS = {
  EARN: "Earned",
  REDEEM: "Redeemed",
  REFUND_REVERSAL: "Refund",
  REFERRAL_BONUS: "Referral bonus",
  MANUAL_ADJUSTMENT: "Adjustment",
};

export default async () => {
  render(<Extension />, document.body);
};

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function nextTierLine(data) {
  if (!data?.nextTierName) return "";
  const bits = [];
  if (data.nextTierRemainingSpend > 0) bits.push(`Spend ${money(data.nextTierRemainingSpend)} more`);
  if (data.nextTierRemainingOrders > 0) {
    const n = data.nextTierRemainingOrders;
    bits.push(`place ${n} more order${n === 1 ? "" : "s"}`);
  }
  if (!bits.length) return "";
  return `${bits.join(" and ")} to reach ${data.nextTierName}`;
}

function Extension() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [referralStatus, setReferralStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${APP_URL}/account-api/points`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await response.json();
        if (!cancelled) setData(json);
      } catch (err) {
        console.error("Failed to load rewards", err);
        if (!cancelled) setError("Couldn't load your rewards right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function requestCode() {
    setReferralStatus("Saving…");
    try {
      const token = await shopify.sessionToken.get();
      const response = await fetch(`${APP_URL}/account-api/points`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await response.json();
      if (json.error) {
        setReferralStatus(json.error);
        return;
      }
      setData((prev) => (prev ? { ...prev, referralCode: json.code } : prev));
      setReferralStatus("");
    } catch {
      setReferralStatus("Couldn't get a code — try again.");
    }
  }

  if (loading) {
    return (
      <s-section heading="Your rewards">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="small" accessibilityLabel="Loading rewards" />
          <s-text color="subdued">Loading your rewards…</s-text>
        </s-stack>
      </s-section>
    );
  }

  if (error || !data?.loggedIn) {
    return (
      <s-section heading="Your rewards">
        <s-banner tone="warning">{error || "Sign in to see your points balance."}</s-banner>
      </s-section>
    );
  }

  const balance = Number(data.pointsBalance || 0);
  const value = data.balanceValue != null ? data.balanceValue : balance / (data.redemptionRate || 1);
  const nextLine = nextTierLine(data);

  return (
    <s-section heading="Your rewards">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-heading>{balance.toLocaleString()} points</s-heading>
          <s-text>{money(value)} to spend</s-text>
          <s-text color="subdued">Redeem from your cart before checkout.</s-text>
          {data.tierName ? <s-text>{data.tierName} tier</s-text> : null}
          {nextLine ? <s-text color="subdued">{nextLine}</s-text> : null}
        </s-stack>

        {data.history?.length ? (
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">Recent activity</s-text>
            {data.history.map((row) => (
              <s-stack key={row.createdAt + row.type} direction="inline" gap="small-200">
                <s-text>
                  {row.points >= 0 ? "+" : ""}
                  {row.points.toLocaleString()}
                </s-text>
                <s-text color="subdued">
                  {TYPE_LABELS[row.type] || row.type}
                  {row.description ? ` · ${row.description}` : ""}
                </s-text>
              </s-stack>
            ))}
          </s-stack>
        ) : null}

        <s-details>
          <s-summary>Share with friends</s-summary>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">
              Friends get a bonus on their first order, and so do you.
            </s-text>
            {data.referralCode ? (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">{data.referralCode}</s-text>
                <s-button commandFor="habit-copy-code" variant="secondary">
                  Copy code
                </s-button>
                <s-clipboard-item id="habit-copy-code" text={data.referralCode} />
              </s-stack>
            ) : (
              <s-button onClick={requestCode}>Get my code</s-button>
            )}
            {referralStatus ? <s-text color="subdued">{referralStatus}</s-text> : null}
          </s-stack>
        </s-details>
      </s-stack>
    </s-section>
  );
}
