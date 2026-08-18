import { PointTransactionType, ReferralCodeStatus } from "@prisma/client";
import type { Customer, ShopSettings, VipTier } from "@prisma/client";
import prisma from "../db.server";

const DEFAULT_SETTINGS = {
  pointsPerDollar: 1,
  redemptionRate: 100,
  minRedeemablePoints: 100,
  maxRedemptionPercent: 50,
  referrerBonusPoints: 500,
  refereeBonusPoints: 250,
  referralCodeExpiryDays: 30,
  maxActiveReferralCodesPerCustomer: 5,
} as const;

export async function getOrCreateShopSettings(shop: string): Promise<ShopSettings> {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop, ...DEFAULT_SETTINGS },
  });
}

export async function getOrCreateCustomer(
  shop: string,
  shopifyCustomerId: string,
  email?: string | null,
  displayName?: string | null,
): Promise<Customer> {
  return prisma.customer.upsert({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
    update: {
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
    },
    create: { shop, shopifyCustomerId, email: email ?? null, displayName: displayName ?? null },
  });
}

/**
 * Picks the highest-sorted VIP tier the customer's lifetime totals qualify
 * for. Tiers with a null threshold on a given axis are ignored on that axis.
 */
export function resolveVipTier(
  tiers: VipTier[],
  lifetimeSpend: number,
  lifetimeOrders: number,
): VipTier | null {
  const qualifying = tiers.filter((tier) => {
    const spendOk = tier.minSpend == null || lifetimeSpend >= Number(tier.minSpend);
    const ordersOk = tier.minOrders == null || lifetimeOrders >= tier.minOrders;
    return spendOk && ordersOk;
  });
  if (qualifying.length === 0) return null;
  return qualifying.sort((a, b) => b.sortOrder - a.sortOrder)[0]!;
}

/**
 * Awards points for a paid order. Idempotent per orderId: if points were
 * already awarded for this order, does nothing (Shopify may redeliver
 * webhooks).
 */
export async function awardPointsForOrder(params: {
  shop: string;
  orderId: string;
  shopifyCustomerId: string;
  customerEmail?: string | null;
  subtotalAmount: number;
}) {
  const { shop, orderId, shopifyCustomerId, customerEmail, subtotalAmount } = params;

  const existing = await prisma.pointTransaction.findFirst({
    where: { shop, orderId, type: PointTransactionType.EARN },
  });
  if (existing) return existing;

  const [settings, customer, tiers] = await Promise.all([
    getOrCreateShopSettings(shop),
    getOrCreateCustomer(shop, shopifyCustomerId, customerEmail),
    prisma.vipTier.findMany({ where: { shop } }),
  ]);

  const currentTier = customer.vipTierId
    ? tiers.find((t) => t.id === customer.vipTierId) ?? null
    : resolveVipTier(tiers, Number(customer.lifetimeSpend), customer.lifetimeOrders);
  const multiplier = currentTier ? Number(currentTier.earnMultiplier) : 1;
  const points = Math.floor(subtotalAmount * Number(settings.pointsPerDollar) * multiplier);

  const lifetimeSpend = Number(customer.lifetimeSpend) + subtotalAmount;
  const lifetimeOrders = customer.lifetimeOrders + 1;
  const nextTier = resolveVipTier(tiers, lifetimeSpend, lifetimeOrders);

  if (points <= 0) {
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        lifetimeSpend,
        lifetimeOrders,
        vipTierId: nextTier?.id ?? null,
        ...(customerEmail ? { email: customerEmail } : {}),
      },
    });
    return null;
  }

  const [transaction] = await prisma.$transaction([
    prisma.pointTransaction.create({
      data: {
        shop,
        customerId: customer.id,
        type: PointTransactionType.EARN,
        points,
        orderId,
        description: `Earned on order (subtotal $${subtotalAmount.toFixed(2)}${
          multiplier !== 1 ? `, ${multiplier}x ${currentTier?.name} tier` : ""
        })`,
      },
    }),
    prisma.customer.update({
      where: { id: customer.id },
      data: {
        pointsBalance: { increment: points },
        lifetimeSpend,
        lifetimeOrders,
        vipTierId: nextTier?.id ?? null,
        ...(customerEmail ? { email: customerEmail } : {}),
      },
    }),
  ]);

  return transaction;
}

/**
 * Reverses points earned on a refunded order. Reverses proportionally to the
 * refunded amount vs. the original order subtotal when possible; falls back
 * to reversing the full EARN amount for that order.
 */
export async function reverseForRefund(params: {
  shop: string;
  orderId: string;
  refundedAmount: number;
  orderSubtotal: number;
}) {
  const { shop, orderId, refundedAmount, orderSubtotal } = params;

  const earnTx = await prisma.pointTransaction.findFirst({
    where: { shop, orderId, type: PointTransactionType.EARN },
  });
  if (!earnTx) return null;

  const alreadyReversed = await prisma.pointTransaction.aggregate({
    where: { shop, orderId, type: PointTransactionType.REFUND_REVERSAL },
    _sum: { points: true },
  });
  const alreadyReversedPoints = Math.abs(alreadyReversed._sum.points ?? 0);

  const proportion = orderSubtotal > 0 ? Math.min(refundedAmount / orderSubtotal, 1) : 1;
  const targetReversal = Math.floor(earnTx.points * proportion);
  const pointsToReverse = Math.min(
    targetReversal - alreadyReversedPoints,
    earnTx.points - alreadyReversedPoints,
  );

  if (pointsToReverse <= 0) return null;

  const [transaction] = await prisma.$transaction([
    prisma.pointTransaction.create({
      data: {
        shop,
        customerId: earnTx.customerId,
        type: PointTransactionType.REFUND_REVERSAL,
        points: -pointsToReverse,
        orderId,
        description: `Refund clawback ($${refundedAmount.toFixed(2)} refunded)`,
      },
    }),
    prisma.customer.update({
      where: { id: earnTx.customerId },
      // Balance can go negative if the customer already redeemed the points —
      // that's intentional; it nets out against future earning.
      data: { pointsBalance: { decrement: pointsToReverse } },
    }),
  ]);

  return transaction;
}

export class RedemptionError extends Error {}

/**
 * Validates and previews a redemption without writing to the ledger. Used by
 * the checkout UI extension (via a session-token-authenticated API route) to
 * decide how many points a buyer is allowed to redeem.
 */
export async function previewRedemption(params: {
  shop: string;
  shopifyCustomerId: string;
  points: number;
}) {
  const { shop, shopifyCustomerId, points } = params;
  const settings = await getOrCreateShopSettings(shop);
  const customer = await getOrCreateCustomer(shop, shopifyCustomerId);

  if (points < settings.minRedeemablePoints) {
    throw new RedemptionError(
      `Minimum redemption is ${settings.minRedeemablePoints} points.`,
    );
  }
  if (points > customer.pointsBalance) {
    throw new RedemptionError("Not enough points for this redemption.");
  }

  return { discountAmount: points / Number(settings.redemptionRate) };
}

/**
 * Finalizes a redemption once an order has actually been paid (called from
 * the orders/paid webhook, reading the points amount the checkout extension
 * wrote to a cart attribute — the same amount the Function used to compute
 * the discount). Idempotent per orderId. Clamps to the customer's current
 * balance rather than throwing, since the discount has already been granted
 * to a completed, paid order by this point; an overdraft here signals a
 * possible race condition or tampered cart attribute worth flagging.
 */
export async function finalizeRedemptionForOrder(params: {
  shop: string;
  orderId: string;
  shopifyCustomerId: string;
  points: number;
}) {
  const { shop, orderId, shopifyCustomerId, points } = params;
  if (points <= 0) return null;

  const existing = await prisma.pointTransaction.findFirst({
    where: { shop, orderId, type: PointTransactionType.REDEEM },
  });
  if (existing) return existing;

  const customer = await getOrCreateCustomer(shop, shopifyCustomerId);
  const pointsToDeduct = Math.min(points, Math.max(customer.pointsBalance, 0));
  if (pointsToDeduct < points) {
    console.warn(
      `Redemption overdraft on order ${orderId} for shop ${shop}: requested ${points}, balance ${customer.pointsBalance}`,
    );
  }
  if (pointsToDeduct <= 0) return null;

  const [transaction] = await prisma.$transaction([
    prisma.pointTransaction.create({
      data: {
        shop,
        customerId: customer.id,
        type: PointTransactionType.REDEEM,
        points: -pointsToDeduct,
        orderId,
        description: `Redeemed at checkout for order discount`,
      },
    }),
    prisma.customer.update({
      where: { id: customer.id },
      data: { pointsBalance: { decrement: pointsToDeduct } },
    }),
  ]);

  return transaction;
}

function generateCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export class ReferralError extends Error {}

/**
 * Creates a referral code for a customer, enforcing the shop's active-code
 * rate limit (fraud protection: prevents mass code generation).
 */
export async function createReferralCode(shop: string, shopifyCustomerId: string) {
  const settings = await getOrCreateShopSettings(shop);
  const owner = await getOrCreateCustomer(shop, shopifyCustomerId);

  const activeCount = await prisma.referralCode.count({
    where: { shop, ownerId: owner.id, status: ReferralCodeStatus.ACTIVE },
  });
  if (activeCount >= settings.maxActiveReferralCodesPerCustomer) {
    throw new ReferralError(
      `You can have at most ${settings.maxActiveReferralCodesPerCustomer} active referral codes at a time.`,
    );
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.referralCodeExpiryDays);

  let code = generateCode();
  for (let attempts = 0; attempts < 5; attempts++) {
    const collision = await prisma.referralCode.findUnique({ where: { code } });
    if (!collision) break;
    code = generateCode();
  }

  return prisma.referralCode.create({
    data: { shop, code, ownerId: owner.id, expiresAt },
  });
}

/**
 * Redeems a referral code on a referred customer's first order, crediting
 * both sides. Expired/already-redeemed/revoked codes are rejected.
 */
export async function redeemReferralCode(params: {
  shop: string;
  code: string;
  refereeShopifyCustomerId: string;
  orderId?: string;
}) {
  const { shop, code, refereeShopifyCustomerId, orderId } = params;
  const settings = await getOrCreateShopSettings(shop);

  const referralCode = await prisma.referralCode.findFirst({
    where: { shop, code: code.toUpperCase() },
  });
  if (!referralCode) throw new ReferralError("Referral code not found.");
  if (referralCode.status !== ReferralCodeStatus.ACTIVE) {
    throw new ReferralError("This referral code is no longer active.");
  }
  if (referralCode.expiresAt && referralCode.expiresAt < new Date()) {
    await prisma.referralCode.update({
      where: { id: referralCode.id },
      data: { status: ReferralCodeStatus.EXPIRED },
    });
    throw new ReferralError("This referral code has expired.");
  }

  const referee = await getOrCreateCustomer(shop, refereeShopifyCustomerId);
  if (referee.id === referralCode.ownerId) {
    throw new ReferralError("You can't refer yourself.");
  }
  const alreadyRedeemed = await prisma.referralCode.findFirst({
    where: { redeemedByCustomerId: referee.id },
  });
  if (alreadyRedeemed) {
    throw new ReferralError("A referral code has already been used on this account.");
  }

  await prisma.$transaction([
    prisma.referralCode.update({
      where: { id: referralCode.id },
      data: {
        status: ReferralCodeStatus.REDEEMED,
        redeemedByCustomerId: referee.id,
        redeemedAt: new Date(),
      },
    }),
    prisma.pointTransaction.create({
      data: {
        shop,
        customerId: referralCode.ownerId,
        type: PointTransactionType.REFERRAL_BONUS,
        points: settings.referrerBonusPoints,
        referralCodeId: referralCode.id,
        orderId,
        description: "Referral bonus (friend's first order)",
      },
    }),
    prisma.customer.update({
      where: { id: referralCode.ownerId },
      data: { pointsBalance: { increment: settings.referrerBonusPoints } },
    }),
    prisma.pointTransaction.create({
      data: {
        shop,
        customerId: referee.id,
        type: PointTransactionType.REFERRAL_BONUS,
        points: settings.refereeBonusPoints,
        referralCodeId: referralCode.id,
        orderId,
        description: "Welcome bonus (referred by a friend)",
      },
    }),
    prisma.customer.update({
      where: { id: referee.id },
      data: { pointsBalance: { increment: settings.refereeBonusPoints } },
    }),
  ]);
}
