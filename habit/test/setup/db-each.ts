import { afterAll, beforeEach } from "vitest";
import prisma from "../../app/db.server";

if (!/localhost:\d+\/habit_test$/.test(process.env.DATABASE_URL ?? "")) {
  // Refuse to truncate anything but the throwaway test database.
  throw new Error(`db tests must run against the embedded test database, not ${process.env.DATABASE_URL}`);
}

const TABLES = [
  "PointTransaction",
  "ReferralCode",
  "NotificationOutbox",
  "Customer",
  "VipTier",
  "ShopSettings",
  "Session",
];

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  // Files share one process (see vitest.config.ts); give the next file its
  // own client so a spy left on this one can't leak into it.
  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
});
