import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Habit" },
  {
    name: "description",
    content: "Loyalty that rewards repeat buyers with points, VIP tiers, and referrals.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Shopify admin loads application_url in an iframe. Never render the public
  // marketing page there — bounce into the embedded app instead.
  if (params.get("shop") || params.get("host") || params.get("embedded")) {
    throw redirect(`/app?${params.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const [showLanding, setShowLanding] = useState(false);

  useEffect(() => {
    if (window.self !== window.top) {
      window.location.replace("/app");
      return;
    }
    setShowLanding(true);
  }, []);

  if (!showLanding) {
    return null;
  }

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <p className={styles.brand}>Habit</p>
        <h1 className={styles.heading}>Loyalty with points, VIP tiers, and referrals</h1>
        <p className={styles.text}>
          Points, VIP tiers, and referrals in one program — flat monthly pricing, no order-count
          cliff.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="on"
              />
            </label>
            <button className={styles.button} type="submit">
              Open Habit
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Points on every order.</strong> Members earn on purchase and
            redeem as a discount at checkout.
          </li>
          <li>
            <strong>VIP tiers.</strong> Repeat buyers unlock a higher earn rate as
            their spend grows.
          </li>
          <li>
            <strong>Referrals in the same ledger.</strong> One program, no extra
            app or extra fee.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy</a>
          {" · "}
          <a href="/support">Support</a>
        </p>
      </div>
    </div>
  );
}
