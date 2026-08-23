import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";

import { APP_STORE_INSTALL_URL } from "../../lib/brand";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Habit" },
  {
    name: "description",
    content: "Loyalty that rewards how customers actually buy.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Shopify admin loads application_url in an iframe. App Pricing welcome
  // links may also land here with only plan_handle (draft Redirect URL is /).
  if (
    params.get("shop") ||
    params.get("host") ||
    params.get("embedded") ||
    params.get("plan_handle") ||
    params.get("charge_id")
  ) {
    throw redirect(`/app?${params.toString()}`);
  }

  return { installUrl: APP_STORE_INSTALL_URL };
};

export default function App() {
  const { installUrl } = useLoaderData<typeof loader>();
  const [showLanding, setShowLanding] = useState(false);

  useEffect(() => {
    if (window.self !== window.top) {
      window.location.replace(`/app${window.location.search}`);
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
        <h1 className={styles.heading}>Loyalty that rewards how customers actually buy</h1>
        <p className={styles.text}>
          Points, VIP tiers, and referrals in one program — built around purchase
          cadence, not just order count.
        </p>
        <a className={styles.button} href={installUrl}>
          Install on Shopify
        </a>
        <p className={styles.text}>
          Already installed? Open Habit from{" "}
          <strong>Settings → Apps and sales channels</strong> in your Shopify admin.
        </p>
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
      </div>
    </div>
  );
}
