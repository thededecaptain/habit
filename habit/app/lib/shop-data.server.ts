import db from "../db.server";

/** Delete all merchant data for GDPR shop/redact and full uninstall cleanup. */
export async function purgeShopData(shop: string) {
  // Sequential deletes — avoids Prisma interactive transactions on PgBouncer.
  await db.pointTransaction.deleteMany({ where: { shop } });
  await db.referralCode.deleteMany({ where: { shop } });
  await db.customer.deleteMany({ where: { shop } });
  await db.vipTier.deleteMany({ where: { shop } });
  await db.notificationOutbox.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
  await db.session.deleteMany({ where: { shop } });
}
