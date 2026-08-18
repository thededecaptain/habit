import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncCustomersFromShopify } from "../lib/loyalty.server";
import { log } from "../lib/logger.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const existing = await db.customer.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!existing) {
    throw new Response("Not found", { status: 404 });
  }

  try {
    await syncCustomersFromShopify(session.shop, admin, [existing.shopifyCustomerId]);
  } catch (error) {
    log("warn", "loyalty.member_sync_failed", { shop: session.shop, error });
  }

  const customer = await db.customer.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      vipTier: true,
      pointTransactions: { orderBy: { createdAt: "desc" }, take: 100 },
      ownedReferralCodes: true,
    },
  });

  if (!customer) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    customer: {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName,
      shopifyCustomerId: customer.shopifyCustomerId,
      pointsBalance: customer.pointsBalance,
      lifetimeSpend: Number(customer.lifetimeSpend),
      lifetimeOrders: customer.lifetimeOrders,
      tierName: customer.vipTier?.name ?? null,
      createdAt: customer.createdAt.toISOString(),
    },
    transactions: customer.pointTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      points: t.points,
      description: t.description,
      orderId: t.orderId,
      createdAt: t.createdAt.toISOString(),
    })),
    referralCodes: customer.ownedReferralCodes.map((c) => ({
      id: c.id,
      code: c.code,
      status: c.status,
      expiresAt: c.expiresAt?.toISOString() ?? null,
    })),
  };
};

const TYPE_LABELS: Record<string, string> = {
  EARN: "Earned",
  REDEEM: "Redeemed",
  REFUND_REVERSAL: "Refund clawback",
  REFERRAL_BONUS: "Referral bonus",
  MANUAL_ADJUSTMENT: "Manual adjustment",
};

const CODE_TONE: Record<string, "success" | "info" | "critical" | "neutral"> = {
  ACTIVE: "info",
  REDEEMED: "success",
  EXPIRED: "neutral",
  REVOKED: "critical",
};

export default function CustomerDetail() {
  const { customer, transactions, referralCodes } = useLoaderData<typeof loader>();

  return (
    <s-page heading={customer.displayName || customer.email || customer.shopifyCustomerId}>
      <s-link slot="breadcrumb-actions" href="/app/customers">
        Members
      </s-link>
      <s-section heading="Overview">
        <s-stack direction="inline" gap="large">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Points balance</s-text>
            <s-heading>{customer.pointsBalance.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">VIP tier</s-text>
            <s-heading>{customer.tierName ?? "Base"}</s-heading>
          </s-stack>
          {customer.displayName && customer.email ? (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Email</s-text>
              <s-heading>{customer.email}</s-heading>
            </s-stack>
          ) : null}
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Lifetime spend</s-text>
            <s-heading>${customer.lifetimeSpend.toFixed(2)}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Orders</s-text>
            <s-heading>{customer.lifetimeOrders}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Member since</s-text>
            <s-heading>{new Date(customer.createdAt).toLocaleDateString()}</s-heading>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Ledger history">
        {transactions.length === 0 ? (
          <s-paragraph color="subdued">No transactions yet.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Date</s-table-header>
              <s-table-header listSlot="labeled">Type</s-table-header>
              <s-table-header listSlot="labeled">Points</s-table-header>
              <s-table-header listSlot="labeled">Notes</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {transactions.map((t) => (
                <s-table-row key={t.id}>
                  <s-table-cell>{new Date(t.createdAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{TYPE_LABELS[t.type] ?? t.type}</s-table-cell>
                  <s-table-cell>
                    <s-text tone={t.points >= 0 ? "success" : "critical"}>
                      {t.points >= 0 ? "+" : ""}
                      {t.points.toLocaleString()}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>{t.description ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Referral codes" slot="aside">
        {referralCodes.length === 0 ? (
          <s-paragraph color="subdued">No referral codes generated.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {referralCodes.map((c) => (
              <s-stack key={c.id} direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">{c.code}</s-text>
                <s-badge tone={CODE_TONE[c.status] ?? "neutral"}>{c.status}</s-badge>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
