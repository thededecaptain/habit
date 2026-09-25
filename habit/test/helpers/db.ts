import prisma from "../../app/db.server";
import { TEST_SHOP } from "./shopify";

export { prisma };

let customerSeq = 1000;

export async function makeSettings(overrides: Record<string, unknown> = {}, shop = TEST_SHOP) {
  return prisma.shopSettings.create({ data: { shop, ...overrides } });
}

export async function makeCustomer(
  overrides: Partial<{
    shop: string;
    shopifyCustomerId: string;
    email: string | null;
    displayName: string | null;
    pointsBalance: number;
    lifetimeSpend: number;
    lifetimeOrders: number;
    vipTierId: string | null;
    syncedPointsBalance: number | null;
    lastActivityAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  customerSeq += 1;
  return prisma.customer.create({
    data: {
      shop: TEST_SHOP,
      shopifyCustomerId: String(customerSeq),
      email: `member${customerSeq}@example.com`,
      ...overrides,
    },
  });
}

export async function makeTier(
  overrides: Partial<{ name: string; minSpend: number | null; minOrders: number | null; earnMultiplier: number; sortOrder: number; shop: string }> = {},
) {
  return prisma.vipTier.create({
    data: { shop: TEST_SHOP, name: `Tier ${Math.random().toString(36).slice(2, 7)}`, earnMultiplier: 1, ...overrides },
  });
}

export async function makeSession(shop = TEST_SHOP, scope = process.env.SCOPES ?? "") {
  return prisma.session.create({
    data: { id: `offline_${shop}`, shop, state: "state", isOnline: false, accessToken: "token", scope },
  });
}

export async function member(shopifyCustomerId: string, shop = TEST_SHOP) {
  return prisma.customer.findUniqueOrThrow({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
    include: { vipTier: true },
  });
}

export async function ledger(shop = TEST_SHOP) {
  return prisma.pointTransaction.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
}

/**
 * Makes Postgres itself fail writes to a table while `fn` runs — a real
 * database error, without patching the Prisma client (spies on it leak).
 */
export async function withFailingWrites<T>(table: string, operation: "INSERT" | "UPDATE" | "DELETE", fn: () => Promise<T>) {
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION habit_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$ LANGUAGE plpgsql`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER habit_test_fail BEFORE ${operation} ON "${table}" FOR EACH ROW EXECUTE FUNCTION habit_test_fail()`,
  );
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS habit_test_fail ON "${table}"`);
  }
}
