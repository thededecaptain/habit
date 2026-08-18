import type { Customer, ShopSettings, VipTier } from "@prisma/client";
import prisma from "../db.server";
import { getOrCreateCustomer, getOrCreateShopSettings, resolveVipTier } from "./ledger.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type LoyaltyHistoryItem = {
  type: string;
  points: number;
  description: string | null;
  createdAt: string;
};

export type LoyaltyCard = {
  loggedIn: true;
  pointsBalance: number;
  balanceValue: number;
  pointsPerDollar: number;
  earnMultiplier: number;
  redemptionRate: number;
  minRedeemablePoints: number;
  maxRedemptionPercent: number;
  tierName: string | null;
  nextTierName: string | null;
  nextTierRemainingSpend: number | null;
  nextTierRemainingOrders: number | null;
  referralCode: string | null;
  history?: LoyaltyHistoryItem[];
};

type ShopifyProfile = {
  id: string;
  email: string | null;
  displayName: string | null;
  amountSpent: number;
  numberOfOrders: number;
};

export function nextTierProgress(
  tiers: VipTier[],
  current: VipTier | null | undefined,
  lifetimeSpend: number,
  lifetimeOrders: number,
) {
  const next = [...tiers]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .find((tier) => !current || tier.sortOrder > current.sortOrder);

  if (!next) {
    return {
      nextTierName: null as string | null,
      nextTierRemainingSpend: null as number | null,
      nextTierRemainingOrders: null as number | null,
    };
  }

  const remainingSpend =
    next.minSpend != null ? Math.max(0, Number(next.minSpend) - lifetimeSpend) : null;
  const remainingOrders =
    next.minOrders != null ? Math.max(0, next.minOrders - lifetimeOrders) : null;

  return {
    nextTierName: next.name,
    nextTierRemainingSpend: remainingSpend,
    nextTierRemainingOrders: remainingOrders,
  };
}

export function ratesPayload(settings: ShopSettings) {
  return {
    loggedIn: false as const,
    pointsPerDollar: Number(settings.pointsPerDollar),
    redemptionRate: Number(settings.redemptionRate),
    minRedeemablePoints: settings.minRedeemablePoints,
    maxRedemptionPercent: Number(settings.maxRedemptionPercent),
  };
}

function displayNameFrom(firstName?: string | null, lastName?: string | null) {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function fetchShopifyCustomers(admin: AdminClient, shopifyCustomerIds: string[]) {
  const ids = [...new Set(shopifyCustomerIds.filter(Boolean))].map(
    (id) => (id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`),
  );
  const map = new Map<string, ShopifyProfile>();
  if (ids.length === 0) return map;

  const response = await admin.graphql(
    `#graphql
    query HabitCustomers($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Customer {
          id
          firstName
          lastName
          defaultEmailAddress { emailAddress }
          amountSpent { amount }
          numberOfOrders
        }
      }
    }`,
    { variables: { ids } },
  );
  const json = await response.json();
  for (const node of json?.data?.nodes ?? []) {
    if (!node?.id) continue;
    const numericId = String(node.id).replace(/^gid:\/\/shopify\/Customer\//, "");
    map.set(numericId, {
      id: numericId,
      email: node.defaultEmailAddress?.emailAddress ?? null,
      displayName: displayNameFrom(node.firstName, node.lastName),
      amountSpent: Number(node.amountSpent?.amount ?? 0),
      numberOfOrders: Number(node.numberOfOrders ?? 0),
    });
  }
  return map;
}

export async function syncCustomersFromShopify(
  shop: string,
  admin: AdminClient,
  shopifyCustomerIds: string[],
) {
  const profiles = await fetchShopifyCustomers(admin, shopifyCustomerIds);
  const tiers = await prisma.vipTier.findMany({ where: { shop } });

  for (const profile of profiles.values()) {
    const customer = await getOrCreateCustomer(
      shop,
      profile.id,
      profile.email,
      profile.displayName,
    );
    const lifetimeSpend = Math.max(Number(customer.lifetimeSpend), profile.amountSpent);
    const lifetimeOrders = Math.max(customer.lifetimeOrders, profile.numberOfOrders);
    const tier = resolveVipTier(tiers, lifetimeSpend, lifetimeOrders);
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        lifetimeSpend,
        lifetimeOrders,
        vipTierId: tier?.id ?? null,
        ...(profile.email ? { email: profile.email } : {}),
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
      },
    });
  }

  return profiles;
}

function toCard(
  settings: ShopSettings,
  customer: (Customer & { vipTier: VipTier | null }) | null,
  next: ReturnType<typeof nextTierProgress>,
  referralCode: string | null,
  history?: LoyaltyHistoryItem[],
): LoyaltyCard {
  const rate = Number(settings.redemptionRate) || 1;
  const balance = customer?.pointsBalance ?? 0;
  return {
    loggedIn: true,
    pointsBalance: balance,
    balanceValue: balance / rate,
    pointsPerDollar: Number(settings.pointsPerDollar),
    earnMultiplier: Number(customer?.vipTier?.earnMultiplier ?? 1),
    redemptionRate: rate,
    minRedeemablePoints: settings.minRedeemablePoints,
    maxRedemptionPercent: Number(settings.maxRedemptionPercent),
    tierName: customer?.vipTier?.name ?? null,
    nextTierName: next.nextTierName,
    nextTierRemainingSpend: next.nextTierRemainingSpend,
    nextTierRemainingOrders: next.nextTierRemainingOrders,
    referralCode,
    ...(history ? { history } : {}),
  };
}

export async function getLoyaltySnapshot(
  shop: string,
  shopifyCustomerId: string,
  options?: { admin?: AdminClient; includeHistory?: boolean },
): Promise<LoyaltyCard> {
  // Only hit Admin GraphQL when we still need a name/email. Storefront and
  // checkout call this on every view — those must stay database-only.
  if (options?.admin) {
    const existing = await prisma.customer.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      select: { email: true, displayName: true },
    });
    if (!existing?.email || !existing?.displayName) {
      try {
        await syncCustomersFromShopify(shop, options.admin, [shopifyCustomerId]);
      } catch (error) {
        console.warn("Could not sync customer from Shopify", error);
      }
    }
  }

  const [settings, customer, tiers] = await Promise.all([
    getOrCreateShopSettings(shop),
    prisma.customer.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      include: { vipTier: true },
    }),
    prisma.vipTier.findMany({ where: { shop }, orderBy: { sortOrder: "asc" } }),
  ]);

  const record =
    customer ??
    (await getOrCreateCustomer(shop, shopifyCustomerId).then((created) =>
      prisma.customer.findUnique({
        where: { id: created.id },
        include: { vipTier: true },
      }),
    ));

  const next = nextTierProgress(
    tiers,
    record?.vipTier,
    Number(record?.lifetimeSpend ?? 0),
    record?.lifetimeOrders ?? 0,
  );

  const activeCode = record
    ? await prisma.referralCode.findFirst({
        where: { shop, ownerId: record.id, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const history = options?.includeHistory && record
    ? (
        await prisma.pointTransaction.findMany({
          where: { shop, customerId: record.id },
          orderBy: { createdAt: "desc" },
          take: 8,
        })
      ).map((row) => ({
        type: row.type,
        points: row.points,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
      }))
    : undefined;

  return toCard(settings, record, next, activeCode?.code ?? null, history);
}
