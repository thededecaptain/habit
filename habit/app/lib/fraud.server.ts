import prisma from "../db.server";

/**
 * Shop-wide velocity check: counts referral codes created in the configured
 * window (uses ReferralCode @@index([shop, createdAt])). If the shop is at or
 * over the threshold, stamps referralVelocityAlertAt so the admin banner shows.
 */
export async function checkReferralVelocity(shop: string) {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!settings) return;

  const windowMs = settings.referralVelocityWindowMinutes * 60 * 1000;
  const since = new Date(Date.now() - windowMs);
  const count = await prisma.referralCode.count({
    where: { shop, createdAt: { gte: since } },
  });

  if (count >= settings.referralVelocityThreshold) {
    await prisma.shopSettings.update({
      where: { shop },
      data: { referralVelocityAlertAt: new Date() },
    });
  }
}
