import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Must be a literal: the extension sandbox has no `process` global and the CLI
// does not substitute env vars, so reading process.env here throws before the
// extension can render. Update this if the app URL changes.
const APP_URL = "https://habit-production-9257.up.railway.app";

export default async () => {
  render(<Extension />, document.body);
};

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function inEditor() {
  return Boolean(shopify.extension?.editor);
}

function EditorPreview() {
  return (
    <s-section heading="Your rewards">
      <s-stack direction="block" gap="base">
        <s-text type="strong">You earned 699 points on this order.</s-text>
        <s-text color="subdued">Preview — buyers see the points this order earned.</s-text>
      </s-stack>
    </s-section>
  );
}

function Extension() {
  const customer = shopify.buyerIdentity?.customer?.value;
  // Points are earned on the subtotal, not the total with shipping and tax.
  const orderSubtotal = Number(
    shopify.cost?.subtotalAmount?.value?.amount ?? shopify.cost?.totalAmount?.value?.amount ?? 0,
  );

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (inEditor()) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        // The server identifies the buyer from the session token.
        const response = await fetch(`${APP_URL}/checkout-api/points`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!cancelled) setData(json);
      } catch (error) {
        console.error("Failed to load rewards", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customer?.id]);

  if (inEditor()) {
    return <EditorPreview />;
  }

  if (loading) {
    return (
      <s-section heading="Your rewards">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="small" accessibilityLabel="Loading rewards" />
          <s-text color="subdued">Checking your rewards…</s-text>
        </s-stack>
      </s-section>
    );
  }

  // Without the shop's earn rate we cannot state a number, so stay generic
  // rather than claiming the order earned zero points.
  if (!data) {
    return (
      <s-section heading="Your rewards">
        <s-text>Points from this order will appear in your account shortly.</s-text>
      </s-section>
    );
  }

  const rate = Number(data.pointsPerDollar || 0);
  const multiplier = Number(data.earnMultiplier || 1);
  const earned = rate > 0 ? Math.floor(orderSubtotal * rate * multiplier) : 0;

  if (!customer?.id || !data.loggedIn) {
    return (
      <s-section heading="Rewards">
        <s-stack direction="block" gap="base">
          {earned > 0 ? (
            <s-text type="strong">This order is worth {earned.toLocaleString()} points.</s-text>
          ) : null}
          <s-banner tone="info">
            Create an account with this email to collect these points and spend them on your next order.
          </s-banner>
        </s-stack>
      </s-section>
    );
  }

  const balance = Number(data.pointsBalance || 0);
  const balanceValue =
    data.balanceValue != null ? data.balanceValue : balance / (data.redemptionRate || 1);

  return (
    <s-section heading="Your rewards">
      <s-stack direction="block" gap="base">
        {earned > 0 ? (
          <s-text type="strong">You earned {earned.toLocaleString()} points on this order.</s-text>
        ) : (
          <s-text type="strong">Your points are on the way.</s-text>
        )}
        <s-text color="subdued">
          They are added once payment is captured, usually within a few minutes.
        </s-text>
        {balance > 0 ? (
          <s-text>
            Balance before this order: {balance.toLocaleString()} points ({money(balanceValue)} to
            spend).
          </s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}
