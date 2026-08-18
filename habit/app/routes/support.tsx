import type { MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { MONTHLY_PLAN, MONTHLY_PLAN_AMOUNT, supportEmail } from "../lib/billing";
import styles from "./_index/styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Support — Habit" },
  { name: "description", content: "Get help with the Habit Shopify loyalty app." },
];

export const loader = async () => {
  return { email: supportEmail(), plan: MONTHLY_PLAN, amount: MONTHLY_PLAN_AMOUNT };
};

export default function Support() {
  const { email, plan, amount } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content} style={{ textAlign: "left", maxWidth: "40rem" }}>
        <p className={styles.brand}>Habit</p>
        <h1 className={styles.heading}>Support</h1>
        <p className={styles.text}>
          Email <a href={`mailto:${email}`}>{email}</a> and include your{" "}
          <code>*.myshopify.com</code> domain. We typically reply within one business day.
        </p>
        <h2>Cancel anytime</h2>
        <p>
          Open Habit in your Shopify admin, go to Settings, and click Cancel subscription. That
          stops the ${amount}/30-day {plan} charge immediately, with unused time prorated. You do
          not need to email us to cancel. Uninstall the app from Shopify if you also want Habit
          removed from the store.
        </p>
        <h2>Theme setup</h2>
        <p>
          After install, use the in-app setup guide to add the product widget and enable Redeem
          points in the theme editor. No theme code edits are required.
        </p>
        <p>
          <Link to="/privacy">Privacy policy</Link>
        </p>
      </div>
    </div>
  );
}
