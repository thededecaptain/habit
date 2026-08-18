import type { MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { supportEmail } from "../lib/billing";
import styles from "./_index/styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Privacy policy — Habit" },
  { name: "description", content: "How Habit collects, uses, and deletes merchant and customer data." },
];

export const loader = async () => {
  return { email: supportEmail() };
};

export default function Privacy() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content} style={{ textAlign: "left", maxWidth: "40rem" }}>
        <p className={styles.brand}>Habit</p>
        <h1 className={styles.heading}>Privacy policy</h1>
        <p className={styles.text}>Last updated: August 18, 2026</p>
        <p>
          Habit is a Shopify loyalty app. This policy describes the data we process to run points,
          VIP tiers, and referrals for merchants who install the app.
        </p>
        <h2>Who we process data for</h2>
        <p>
          We act as a service provider to the merchant. The merchant is the controller of their
          store&apos;s customer data. Shopify is the platform that hosts the store and delivers
          webhooks and authentication.
        </p>
        <h2>Data we collect</h2>
        <ul>
          <li>Shop domain and offline session tokens needed to keep the app installed.</li>
          <li>Shopify customer IDs, email addresses, and display names for members.</li>
          <li>Order IDs and subtotals used to award, redeem, and claw back points.</li>
          <li>Referral codes and point ledger history for the merchant&apos;s program.</li>
          <li>Billing status from Shopify (plan name and subscription id).</li>
        </ul>
        <h2>How we use it</h2>
        <p>
          We use this data only to operate the loyalty program: earn and redeem points, apply VIP
          multipliers, issue referral bonuses, reverse points on refunds, and show balances in the
          Shopify admin, storefront widget, checkout, and customer accounts.
        </p>
        <h2>Sharing</h2>
        <p>
          We do not sell personal data. We share data with Shopify (to authenticate, bill, and
          apply discounts) and with our hosting and database providers (Railway and Postgres) as
          needed to run the app. Optional error tracking (Sentry) may receive technical diagnostics
          if the merchant&apos;s deployment has it enabled.
        </p>
        <h2>Retention and deletion</h2>
        <p>
          Member PII is cleared when Shopify sends a <code>customers/redact</code> webhook. All
          shop data, including sessions, is deleted when Shopify sends a <code>shop/redact</code>{" "}
          webhook after uninstall. Merchants can also uninstall Habit from the Shopify admin at any
          time; billing can be canceled from Settings without contacting support.
        </p>
        <h2>Customer data requests</h2>
        <p>
          When Shopify sends a <code>customers/data_request</code> webhook, we assemble the
          customer&apos;s ledger export and store it for the merchant to download from Habit
          Settings and deliver to the customer.
        </p>
        <h2>Contact</h2>
        <p>
          Privacy questions: <a href={`mailto:${email}`}>{email}</a>.{" "}
          <Link to="/support">Support</Link>.
        </p>
      </div>
    </div>
  );
}
