import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Baked in at deploy via Shopify CLI; production fallback keeps published builds working.
const APP_URL =
  process.env.SHOPIFY_APP_URL || "https://habit-production-9257.up.railway.app";

export default async () => {
  render(<Announcement />, document.body);
};

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

/**
 * Compact rewards banner for announcement targets.
 * Root must be <s-announcement> for profile / order-index announcement slots.
 */
function Announcement() {
  const [text, setText] = useState("Loading your Habit rewards…");

  useEffect(() => {
    if (shopify.extension?.editor) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${APP_URL}/account-api/points`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled) return;
        if (!data?.loggedIn) {
          setText("Sign in to see your Habit rewards balance.");
          return;
        }
        const balance = Number(data.pointsBalance || 0);
        const value =
          data.balanceValue != null ? data.balanceValue : balance / (data.redemptionRate || 1);
        setText(
          balance > 0
            ? `You have ${balance.toLocaleString()} Habit points (${money(value)} to spend). Redeem in cart or at checkout.`
            : "Earn Habit points on every purchase — redeem them in cart or at checkout.",
        );
      } catch {
        if (!cancelled) setText("Habit rewards are available when you shop this store.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (shopify.extension?.editor) {
    return <s-announcement>You have 1,250 Habit points ($12.50 to spend). Preview.</s-announcement>;
  }

  return <s-announcement>{text}</s-announcement>;
}
