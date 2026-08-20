import prisma from "../db.server";
import {
  DAY_MS,
  expireInactiveBalances,
  lastPurchaseActivity,
} from "./ledger.server";
import {
  enqueueLoyaltyEvent,
  EVENT_POINTS_EXPIRING_SOON,
  processOutbox,
} from "./notifications.server";

export async function runOutboxJob() {
  return processOutbox();
}

const SOON_BATCH = 200;

export async function enqueueExpiringSoonEvents() {
  const shops = await prisma.shopSettings.findMany({
    where: { pointsExpiryDays: { not: null } },
    select: { shop: true, pointsExpiryDays: true },
  });

  let enqueued = 0;
  const now = Date.now();

  for (const shop of shops) {
    const days = shop.pointsExpiryDays;
    if (days == null || days <= 0) continue;

    const expiredBefore = new Date(now - days * DAY_MS);
    const soonAfter = new Date(now - days * DAY_MS + 7 * DAY_MS);

    const members = await prisma.customer.findMany({
      where: {
        shop: shop.shop,
        pointsBalance: { gt: 0 },
        email: { not: null },
        OR: [
          { lastActivityAt: { gt: expiredBefore, lte: soonAfter } },
          { lastActivityAt: null, createdAt: { gt: expiredBefore, lte: soonAfter } },
        ],
      },
      take: SOON_BATCH,
    });

    for (const member of members) {
      if (!member.email) continue;
      const last = lastPurchaseActivity(member);
      const expiryMs = last.getTime() + days * DAY_MS;
      const expiresInDays = Math.ceil((expiryMs - now) / DAY_MS);
      if (expiresInDays < 1 || expiresInDays > 7) continue;

      const expiresOn = new Date(expiryMs).toISOString();
      const expiryDateISO = expiresOn.slice(0, 10);

      await enqueueLoyaltyEvent(prisma, {
        shop: shop.shop,
        eventName: EVENT_POINTS_EXPIRING_SOON,
        customerEmail: member.email,
        uniqueKey: `${EVENT_POINTS_EXPIRING_SOON}:${member.id}:${expiryDateISO}`,
        properties: {
          pointsBalance: member.pointsBalance,
          expiresInDays,
          expiresOn,
        },
      });
      enqueued += 1;
    }
  }

  return enqueued;
}

export async function runExpirePointsJob() {
  const expired = await expireInactiveBalances();
  const expiringSoon = await enqueueExpiringSoonEvents();
  return { expired, expiringSoon };
}
