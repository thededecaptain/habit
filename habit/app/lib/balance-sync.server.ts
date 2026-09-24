import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

/**
 * Mirrors each member's points balance into an app-owned customer metafield
 * ($app:points_balance). The checkout discount Function reads it to cap a
 * redemption at what the buyer actually has — the cart attribute holding the
 * requested points is shopper-editable, so the Function can't trust it alone.
 *
 * A balance is "dirty" when syncedPointsBalance is null or differs from
 * pointsBalance. Writers call syncPointsBalances right after changing a
 * balance; the cron sweep catches anything that failed or was changed
 * elsewhere (e.g. expiry).
 */

export const POINTS_BALANCE_KEY = "points_balance";
// metafieldsSet accepts at most 25 metafields per call.
const METAFIELDS_PER_CALL = 25;
const SWEEP_LIMIT = 500;

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// Field references support lt/gt but not "not equal".
const DIRTY: Prisma.CustomerWhereInput = {
  OR: [
    { syncedPointsBalance: null },
    { syncedPointsBalance: { lt: prisma.customer.fields.pointsBalance } },
    { syncedPointsBalance: { gt: prisma.customer.fields.pointsBalance } },
  ],
};

function dirtyWhere(shop: string, customerIds?: string[]): Prisma.CustomerWhereInput {
  return { shop, ...(customerIds ? { id: { in: customerIds } } : {}), ...DIRTY };
}

async function writeBatch(
  admin: AdminClient,
  batch: { id: string; shopifyCustomerId: string; pointsBalance: number }[],
) {
  const response = await admin.graphql(
    `#graphql
    mutation SetPointsBalances($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { owner { ... on Customer { id } } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: batch.map((c) => ({
          ownerId: `gid://shopify/Customer/${c.shopifyCustomerId}`,
          namespace: "$app",
          key: POINTS_BALANCE_KEY,
          type: "number_integer",
          value: String(Math.max(0, c.pointsBalance)),
        })),
      },
    },
  );
  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    // A customer deleted in Shopify fails its own entry; keep the rest.
    console.warn("Points balance metafield userErrors", errors);
  }
  const written = new Set<string>(
    (json?.data?.metafieldsSet?.metafields ?? [])
      .map((m: { owner?: { id?: string } }) => m?.owner?.id)
      .filter(Boolean),
  );

  for (const c of batch) {
    if (!written.has(`gid://shopify/Customer/${c.shopifyCustomerId}`)) continue;
    // Record the value we wrote, not the current one: if the balance moved
    // while we were writing, the row stays dirty for the next pass.
    await prisma.customer.update({
      where: { id: c.id },
      data: { syncedPointsBalance: c.pointsBalance },
    });
  }
  return written.size;
}

/** Writes dirty balances for one shop. Never throws; returns how many synced. */
export async function syncPointsBalances(
  shop: string,
  options: { customerIds?: string[]; admin?: AdminClient; limit?: number } = {},
) {
  try {
    const customers = await prisma.customer.findMany({
      where: dirtyWhere(shop, options.customerIds),
      select: { id: true, shopifyCustomerId: true, pointsBalance: true },
      take: options.limit ?? SWEEP_LIMIT,
    });
    if (customers.length === 0) return 0;

    const admin = options.admin ?? (await unauthenticated.admin(shop)).admin;
    let synced = 0;
    for (let i = 0; i < customers.length; i += METAFIELDS_PER_CALL) {
      synced += await writeBatch(admin, customers.slice(i, i + METAFIELDS_PER_CALL));
    }
    return synced;
  } catch (error) {
    // Expected until a shop approves write_customers; the cron retries, so
    // one line is enough (the full error object dumps the whole response).
    const message = error instanceof Error ? error.message.split(". ")[0] : String(error);
    console.warn(`Points balance sync failed for ${shop}: ${message}`);
    return 0;
  }
}

/** Cron safety net: syncs dirty balances across every installed shop. */
export async function sweepPointsBalances() {
  const shops = await prisma.customer.findMany({
    where: DIRTY,
    distinct: ["shop"],
    select: { shop: true },
  });
  const installed = new Set(
    (
      await prisma.session.findMany({
        where: { shop: { in: shops.map((s) => s.shop) }, isOnline: false },
        select: { shop: true },
      })
    ).map((s) => s.shop),
  );

  let synced = 0;
  for (const { shop } of shops) {
    if (!installed.has(shop)) continue;
    synced += await syncPointsBalances(shop);
  }
  return synced;
}
