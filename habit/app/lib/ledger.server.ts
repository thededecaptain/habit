import { PointTransactionType, Prisma, ReferralCodeStatus } from "@prisma/client";
import type { Customer, ShopSettings, VipTier } from "@prisma/client";
import prisma from "../db.server";
import { checkReferralVelocity } from "./fraud.server";
import {
  enqueueLoyaltyEvent,
  EVENT_POINTS_EARNED,
  EVENT_POINTS_EXPIRED,
  EVENT_POINTS_REDEEMED,
  EVENT_REFERRAL_SENT,
  EVENT_REFERRAL_WELCOME,
  EVENT_TIER_UPGRADED,
} from "./notifications.server";

const DEFAULT_SETTINGS = {
  pointsPerDollar: 1,
  redemptionRate: 100,
  minRedeemablePoints: 100,
  maxRedemptionPercent: 50,
  referrerBonusPoints: 500,
  refereeBonusPoints: 250,
  referralCodeExpiryDays: 30,
  maxActiveReferralCodesPerCustomer: 5,
  referralVelocityThreshold: 50,
  referralVelocityWindowMinutes: 60,
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRE_BATCH = 100;

export function lastPurchaseActivity(customer: {
  lastActivityAt: Date | null;
  createdAt: Date;
}) {
  return customer.lastActivityAt ?? customer.createdAt;
}

export async function getOrCreateShopSettings(shop: string): Promise<ShopSettings> {
  const existing = await prisma.shopSettings.findUnique({ where: { shop } });
  if (existing) return existing;

  try {
    return await prisma.shopSettings.create({ data: { shop, ...DEFAULT_SETTINGS } });
  } catch {
    return prisma.shopSettings.findUniqueOrThrow({ where: { shop } });
  }
}

export async function getOrCreateCustomer(
  shop: string,
  shopifyCustomerId: string,
  email?: string | null,
  displayName?: string | null,
): Promise<Customer> {
  const upsert = () =>
    prisma.customer.upsert({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      update: {
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
      },
      create: { shop, shopifyCustomerId, email: email ?? null, displayName: displayName ?? null },
    });
  try {
    return await upsert();
  } catch (error) {
    // Two webhooks for a brand-new customer (say, two orders paid at once)
    // can both try to insert; the loser retries as an update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return upsert();
    }
    throw error;
  }
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
  return [...qualifying].sort(compareTiers).at(-1)!;
}

/**
 * Tier rank, lowest first: by the merchant's sort order, then — when sort
 * orders tie (both left at 0) — by threshold, so a higher bar ranks higher.
 */
export function compareTiers(a: VipTier, b: VipTier) {
  return (
    a.sortOrder - b.sortOrder ||
    Number(a.minSpend ?? 0) - Number(b.minSpend ?? 0) ||
    (a.minOrders ?? 0) - (b.minOrders ?? 0) ||
    Number(a.earnMultiplier) - Number(b.earnMultiplier)
  );
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Locks the member's row for the rest of the transaction and returns it
 * fresh. Serializes ledger writes per member, so a webhook Shopify delivers
 * twice at once, or two orders paid together, can't both pass an
 * "already processed?" check or overwrite each other's lifetime totals.
 */
async function lockCustomer(tx: Tx, customerId: string) {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
  return tx.customer.findUniqueOrThrow({ where: { id: customerId } });
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

  const alreadyAwarded = () =>
    prisma.pointTransaction.findFirst({
      where: { shop, orderId, type: PointTransactionType.EARN },
    });
  const existing = await alreadyAwarded();
  if (existing) return existing;

  const [settings, member, tiers] = await Promise.all([
    getOrCreateShopSettings(shop),
    getOrCreateCustomer(shop, shopifyCustomerId, customerEmail),
    prisma.vipTier.findMany({ where: { shop } }),
  ]);

  return prisma.$transaction(async (tx) => {
    const customer = await lockCustomer(tx, member.id);
    const duplicate = await tx.pointTransaction.findFirst({
      where: { shop, orderId, type: PointTransactionType.EARN },
    });
    if (duplicate) return duplicate;

    const currentTier = customer.vipTierId
      ? tiers.find((t) => t.id === customer.vipTierId) ?? null
      : resolveVipTier(tiers, Number(customer.lifetimeSpend), customer.lifetimeOrders);
    const multiplier = currentTier ? Number(currentTier.earnMultiplier) : 1;
    const points = Math.floor(subtotalAmount * Number(settings.pointsPerDollar) * multiplier);

    const lifetimeSpend = Number(customer.lifetimeSpend) + subtotalAmount;
    const lifetimeOrders = customer.lifetimeOrders + 1;
    const nextTier = resolveVipTier(tiers, lifetimeSpend, lifetimeOrders);
    const tierUpgraded = Boolean(nextTier && nextTier.id !== customer.vipTierId);
    const email = customerEmail ?? customer.email;

    await tx.customer.update({
      where: { id: customer.id },
      data: {
        ...(points > 0 ? { pointsBalance: { increment: points } } : {}),
        lifetimeSpend,
        lifetimeOrders,
        vipTierId: nextTier?.id ?? null,
        lastActivityAt: new Date(),
        ...(customerEmail ? { email: customerEmail } : {}),
      },
    });

    // Recorded even at 0 points: this row is what makes a redelivered
    // webhook a no-op, including for the order's lifetime totals.
    const transaction = await tx.pointTransaction.create({
      data: {
        shop,
        customerId: customer.id,
        type: PointTransactionType.EARN,
        points: Math.max(points, 0),
        orderId,
        description: `Earned on order (subtotal $${subtotalAmount.toFixed(2)}${
          multiplier !== 1 ? `, ${multiplier}x ${currentTier?.name} tier` : ""
        })`,
      },
    });

    if (points > 0) {
      await enqueueLoyaltyEvent(tx, {
        shop,
        eventName: EVENT_POINTS_EARNED,
        customerEmail: email,
        shopifyCustomerId: customer.shopifyCustomerId,
        orderId,
        uniqueKey: `${EVENT_POINTS_EARNED}:${transaction.id}`,
        properties: { points, orderId, pointsBalance: customer.pointsBalance + points },
      });
    }
    if (tierUpgraded && nextTier) {
      await enqueueLoyaltyEvent(tx, {
        shop,
        eventName: EVENT_TIER_UPGRADED,
        customerEmail: email,
        shopifyCustomerId: customer.shopifyCustomerId,
        orderId,
        uniqueKey: `${EVENT_TIER_UPGRADED}:${customer.id}:${orderId}`,
        properties: {
          tierName: nextTier.name,
          tierId: nextTier.id,
          lifetimeSpend,
          lifetimeOrders,
          orderId,
        },
      });
    }
    return transaction;
  });
}

/**
 * Handles a refund on an order, in proportion to how much of the order's
 * subtotal has been refunded so far (refundedAmount is cumulative):
 *  - claws back the points the order earned;
 *  - gives back the points spent on the order's discount;
 *  - on a full refund, reverses the referral bonuses the order triggered
 *    (a friend ordering, collecting the bonus, then refunding);
 *  - takes the refunded spend (and, on a full refund, the order) back out
 *    of the member's lifetime totals and re-ranks their VIP tier, so a
 *    refunded order can't buy tier status.
 * Each part is tracked by what was already reversed for the order, so
 * several partial refunds add up correctly and a redelivered webhook is a
 * no-op.
 */
export async function reverseForRefund(params: {
  shop: string;
  orderId: string;
  refundedAmount: number;
  orderSubtotal: number;
}) {
  const { shop, orderId, refundedAmount, orderSubtotal } = params;
  const proportion = orderSubtotal > 0 ? Math.min(refundedAmount / orderSubtotal, 1) : 1;

  const rows = await prisma.pointTransaction.findMany({ where: { shop, orderId } });
  if (rows.length === 0) return [];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const tiers = await prisma.vipTier.findMany({ where: { shop } });

  return prisma.$transaction(async (tx) => {
    for (const id of customerIds) await lockCustomer(tx, id);
    const current = await tx.pointTransaction.findMany({ where: { shop, orderId } });
    const sum = (type: PointTransactionType, customerId?: string) =>
      current
        .filter((r) => r.type === type && (!customerId || r.customerId === customerId))
        .reduce((total, r) => total + r.points, 0);

    const created = [];
    const apply = async (customerId: string, points: number, type: PointTransactionType, description: string) => {
      if (points === 0) return;
      created.push(
        await tx.pointTransaction.create({
          data: { shop, customerId, type, points, orderId, description },
        }),
      );
      // Balance can go negative if the customer already spent the points
      // being clawed back — intentional; it nets out against future earning.
      await tx.customer.update({
        where: { id: customerId },
        data: { pointsBalance: { increment: points } },
      });
    };

    const refundNote = `$${refundedAmount.toFixed(2)} refunded so far`;

    const earn = current.find((r) => r.type === PointTransactionType.EARN);
    if (earn) {
      // Referral-bonus reversals are REFUND_REVERSAL rows too; skip them.
      const reversed = Math.abs(
        current
          .filter(
            (r) =>
              r.type === PointTransactionType.REFUND_REVERSAL &&
              r.customerId === earn.customerId &&
              r.referralCodeId == null,
          )
          .reduce((total, r) => total + r.points, 0),
      );
      const target = Math.floor(earn.points * proportion);
      await apply(
        earn.customerId,
        -Math.max(0, Math.min(target, earn.points) - reversed),
        PointTransactionType.REFUND_REVERSAL,
        `Refund clawback (${refundNote})`,
      );

      // Lifetime totals: remove only what earlier refunds haven't already.
      const spendDelta = Math.max(0, refundedAmount - Number(earn.spendReversed ?? 0));
      const uncountOrder = proportion >= 1 && !earn.orderCountReversed;
      if (spendDelta > 0 || uncountOrder) {
        await tx.pointTransaction.update({
          where: { id: earn.id },
          data: {
            spendReversed: Math.max(refundedAmount, Number(earn.spendReversed ?? 0)),
            ...(uncountOrder ? { orderCountReversed: true } : {}),
          },
        });
        const member = await tx.customer.findUniqueOrThrow({ where: { id: earn.customerId } });
        const lifetimeSpend = Math.max(0, Number(member.lifetimeSpend) - spendDelta);
        const lifetimeOrders = Math.max(0, member.lifetimeOrders - (uncountOrder ? 1 : 0));
        await tx.customer.update({
          where: { id: member.id },
          data: {
            lifetimeSpend,
            lifetimeOrders,
            vipTierId: resolveVipTier(tiers, lifetimeSpend, lifetimeOrders)?.id ?? null,
          },
        });
      }
    }

    const redeem = current.find((r) => r.type === PointTransactionType.REDEEM);
    if (redeem) {
      const spent = Math.abs(redeem.points);
      const returned = sum(PointTransactionType.REDEMPTION_REFUND, redeem.customerId);
      const target = Math.floor(spent * proportion);
      await apply(
        redeem.customerId,
        Math.max(0, Math.min(target, spent) - returned),
        PointTransactionType.REDEMPTION_REFUND,
        `Points returned (${refundNote})`,
      );
    }

    if (proportion >= 1) {
      for (const bonus of current.filter((r) => r.type === PointTransactionType.REFERRAL_BONUS)) {
        const alreadyReversed = current.some(
          (r) =>
            r.type === PointTransactionType.REFUND_REVERSAL &&
            r.customerId === bonus.customerId &&
            r.referralCodeId === bonus.referralCodeId,
        );
        if (alreadyReversed || bonus.points <= 0) continue;
        created.push(
          await tx.pointTransaction.create({
            data: {
              shop,
              customerId: bonus.customerId,
              type: PointTransactionType.REFUND_REVERSAL,
              points: -bonus.points,
              orderId,
              referralCodeId: bonus.referralCodeId,
              description: "Referral bonus reversed (referred order refunded)",
            },
          }),
        );
        await tx.customer.update({
          where: { id: bonus.customerId },
          data: { pointsBalance: { decrement: bonus.points } },
        });
      }
    }

    return created;
  });
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
 * the orders/paid webhook with the points the order's loyalty discount was
 * worth). Idempotent per orderId. Clamps to the customer's current balance
 * rather than throwing, since the discount has already been granted to a
 * completed, paid order by this point; an overdraft here signals a race
 * (two carts spending the same points) worth flagging.
 */
export async function finalizeRedemptionForOrder(params: {
  shop: string;
  orderId: string;
  shopifyCustomerId: string;
  points: number;
}) {
  const { shop, orderId, shopifyCustomerId, points } = params;
  if (points <= 0) return null;

  const member = await getOrCreateCustomer(shop, shopifyCustomerId);

  return prisma.$transaction(async (tx) => {
    const customer = await lockCustomer(tx, member.id);
    const existing = await tx.pointTransaction.findFirst({
      where: { shop, orderId, type: PointTransactionType.REDEEM },
    });
    if (existing) return existing;

    const pointsToDeduct = Math.min(points, Math.max(customer.pointsBalance, 0));
    if (pointsToDeduct < points) {
      console.warn(
        `Redemption overdraft on order ${orderId} for shop ${shop}: requested ${points}, balance ${customer.pointsBalance}`,
      );
    }
    if (pointsToDeduct <= 0) return null;

    const newBalance = customer.pointsBalance - pointsToDeduct;
    const transaction = await tx.pointTransaction.create({
      data: {
        shop,
        customerId: customer.id,
        type: PointTransactionType.REDEEM,
        points: -pointsToDeduct,
        orderId,
        description: `Redeemed at checkout for order discount`,
      },
    });
    await tx.customer.update({
      where: { id: customer.id },
      data: { pointsBalance: { decrement: pointsToDeduct }, lastActivityAt: new Date() },
    });
    await enqueueLoyaltyEvent(tx, {
      shop,
      eventName: EVENT_POINTS_REDEEMED,
      customerEmail: customer.email,
      shopifyCustomerId: customer.shopifyCustomerId,
      orderId,
      uniqueKey: `${EVENT_POINTS_REDEEMED}:${transaction.id}`,
      properties: { points: pointsToDeduct, orderId, pointsBalance: newBalance },
    });
    return transaction;
  });
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

const REFERRAL_CODE_PATTERN = /^[A-Z0-9_-]{4,24}$/;

/** Uppercases a code and checks it's something a shopper can type. */
export function normalizeReferralCode(raw: string) {
  const code = raw.trim().toUpperCase();
  if (!REFERRAL_CODE_PATTERN.test(code)) {
    throw new ReferralError(
      "Codes must be 4–24 characters: letters, numbers, dashes, or underscores.",
    );
  }
  return code;
}

/**
 * Creates a referral code for a customer, enforcing the shop's active-code
 * rate limit (fraud protection: prevents mass code generation).
 *
 * Merchants creating codes from the admin can choose the code and expiry and
 * are not held to the per-customer limit, which exists to stop shoppers from
 * minting codes in bulk.
 */
export async function createReferralCode(
  shop: string,
  shopifyCustomerId: string,
  options: {
    code?: string;
    // null = never expires; undefined = the shop's default expiry.
    expiresInDays?: number | null;
    createdByMerchant?: boolean;
    email?: string | null;
    displayName?: string | null;
  } = {},
) {
  const settings = await getOrCreateShopSettings(shop);
  const owner = await getOrCreateCustomer(
    shop,
    shopifyCustomerId,
    options.email,
    options.displayName,
  );

  if (!options.createdByMerchant) {
    const activeCount = await prisma.referralCode.count({
      where: { shop, ownerId: owner.id, status: ReferralCodeStatus.ACTIVE },
    });
    if (activeCount >= settings.maxActiveReferralCodesPerCustomer) {
      throw new ReferralError(
        `You can have at most ${settings.maxActiveReferralCodesPerCustomer} active referral codes at a time.`,
      );
    }
  }

  const expiresInDays =
    options.expiresInDays === undefined ? settings.referralCodeExpiryDays : options.expiresInDays;
  const expiresAt = expiresInDays == null ? null : new Date(Date.now() + expiresInDays * DAY_MS);

  let code: string;
  if (options.code) {
    code = normalizeReferralCode(options.code);
    const taken = await prisma.referralCode.findUnique({
      where: { shop_code: { shop, code } },
    });
    if (taken) throw new ReferralError(`The code ${code} is already in use.`);
  } else {
    code = generateCode();
    for (let attempts = 0; attempts < 5; attempts++) {
      const collision = await prisma.referralCode.findUnique({
        where: { shop_code: { shop, code } },
      });
      if (!collision) break;
      code = generateCode();
    }
  }

  const created = await prisma.referralCode.create({
    data: { shop, code, ownerId: owner.id, expiresAt },
  });

  try {
    await checkReferralVelocity(shop);
  } catch (error) {
    console.warn(`Referral velocity check failed for ${shop}`, error);
  }

  return created;
}

/**
 * Checks whether a code would be accepted, without redeeming it. Lets the
 * cart tell a shopper up front instead of silently ignoring a bad code after
 * the order is placed. The final check still happens in redeemReferralCode.
 */
export async function checkReferralCode(params: {
  shop: string;
  code: string;
  refereeShopifyCustomerId?: string | null;
}) {
  const { shop, refereeShopifyCustomerId } = params;
  const code = params.code.trim().toUpperCase();
  const referralCode = code
    ? await prisma.referralCode.findUnique({
        where: { shop_code: { shop, code } },
        include: { owner: true },
      })
    : null;
  if (!referralCode) throw new ReferralError("That referral code doesn't exist.");
  if (referralCode.status !== ReferralCodeStatus.ACTIVE) {
    throw new ReferralError("This referral code is no longer active.");
  }
  if (referralCode.expiresAt && referralCode.expiresAt < new Date()) {
    throw new ReferralError("This referral code has expired.");
  }
  if (refereeShopifyCustomerId) {
    if (referralCode.owner.shopifyCustomerId === refereeShopifyCustomerId) {
      throw new ReferralError("You can't use your own referral code.");
    }
    const referee = await prisma.customer.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: refereeShopifyCustomerId } },
      include: { redeemedReferralCode: true },
    });
    if (referee?.redeemedReferralCode) {
      throw new ReferralError("A referral code has already been used on this account.");
    }
    if (referee && referee.lifetimeOrders > 0) {
      throw new ReferralError("Referral codes are for a customer's first order.");
    }
  }
  const settings = await getOrCreateShopSettings(shop);
  return { code: referralCode.code, refereeBonusPoints: settings.refereeBonusPoints };
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

  const referralCode = await prisma.referralCode.findUnique({
    where: { shop_code: { shop, code: code.trim().toUpperCase() } },
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
  // Runs after this order was counted, so a first order shows as 1.
  if (referee.lifetimeOrders > 1) {
    throw new ReferralError("Referral codes are for a customer's first order.");
  }
  const alreadyRedeemed = await prisma.referralCode.findFirst({
    where: { redeemedByCustomerId: referee.id },
  });
  if (alreadyRedeemed) {
    throw new ReferralError("A referral code has already been used on this account.");
  }

  const owner = await prisma.customer.findUniqueOrThrow({
    where: { id: referralCode.ownerId },
  });

  await prisma.$transaction(async (tx) => {
    // Conditional on still being ACTIVE: a webhook delivered twice at once
    // must not pay the bonuses twice.
    const claimed = await tx.referralCode.updateMany({
      where: { id: referralCode.id, status: ReferralCodeStatus.ACTIVE },
      data: {
        status: ReferralCodeStatus.REDEEMED,
        redeemedByCustomerId: referee.id,
        redeemedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      throw new ReferralError("This referral code is no longer active.");
    }
    const referrerTx = await tx.pointTransaction.create({
      data: {
        shop,
        customerId: referralCode.ownerId,
        type: PointTransactionType.REFERRAL_BONUS,
        points: settings.referrerBonusPoints,
        referralCodeId: referralCode.id,
        orderId,
        description: "Referral bonus (friend's first order)",
      },
    });
    await tx.customer.update({
      where: { id: referralCode.ownerId },
      data: { pointsBalance: { increment: settings.referrerBonusPoints } },
    });
    const refereeTx = await tx.pointTransaction.create({
      data: {
        shop,
        customerId: referee.id,
        type: PointTransactionType.REFERRAL_BONUS,
        points: settings.refereeBonusPoints,
        referralCodeId: referralCode.id,
        orderId,
        description: "Welcome bonus (referred by a friend)",
      },
    });
    await tx.customer.update({
      where: { id: referee.id },
      data: { pointsBalance: { increment: settings.refereeBonusPoints } },
    });
    await enqueueLoyaltyEvent(tx, {
      shop,
      eventName: EVENT_REFERRAL_SENT,
      customerEmail: owner.email,
      shopifyCustomerId: owner.shopifyCustomerId,
      orderId,
      uniqueKey: `${EVENT_REFERRAL_SENT}:${referrerTx.id}`,
      properties: { bonusPoints: settings.referrerBonusPoints, code: referralCode.code },
    });
    await enqueueLoyaltyEvent(tx, {
      shop,
      eventName: EVENT_REFERRAL_WELCOME,
      customerEmail: referee.email,
      shopifyCustomerId: referee.shopifyCustomerId,
      orderId,
      uniqueKey: `${EVENT_REFERRAL_WELCOME}:${refereeTx.id}`,
      properties: { bonusPoints: settings.refereeBonusPoints, code: referralCode.code },
    });
  });
}

/**
 * Zeroes inactive balances for shops with points expiry enabled.
 * Purchase-only clock: lastActivityAt (EARN/REDEEM) coalesced with createdAt.
 */
export async function expireInactiveBalances() {
  const shops = await prisma.shopSettings.findMany({
    where: { pointsExpiryDays: { not: null } },
    select: { shop: true, pointsExpiryDays: true },
  });

  let expired = 0;

  for (const shop of shops) {
    const days = shop.pointsExpiryDays;
    if (days == null || days <= 0) continue;

    const cutoff = new Date(Date.now() - days * DAY_MS);
    const members = await prisma.customer.findMany({
      where: {
        shop: shop.shop,
        pointsBalance: { gt: 0 },
        OR: [
          { lastActivityAt: { lte: cutoff } },
          { lastActivityAt: null, createdAt: { lte: cutoff } },
        ],
      },
      take: EXPIRE_BATCH,
    });

    for (const member of members) {
      const didExpire = await prisma.$transaction(async (tx) => {
        const fresh = await tx.customer.findUnique({ where: { id: member.id } });
        if (!fresh || fresh.pointsBalance <= 0) return false;
        if (lastPurchaseActivity(fresh) > cutoff) return false;

        const pointsExpired = fresh.pointsBalance;
        const expireTx = await tx.pointTransaction.create({
          data: {
            shop: shop.shop,
            customerId: fresh.id,
            type: PointTransactionType.EXPIRE,
            points: -pointsExpired,
            description: `Expired after ${days} days of purchase inactivity`,
          },
        });
        await tx.customer.update({
          where: { id: fresh.id },
          data: { pointsBalance: 0 },
        });
        await enqueueLoyaltyEvent(tx, {
          shop: shop.shop,
          eventName: EVENT_POINTS_EXPIRED,
          customerEmail: fresh.email,
          shopifyCustomerId: fresh.shopifyCustomerId,
          uniqueKey: `${EVENT_POINTS_EXPIRED}:${expireTx.id}`,
          properties: { pointsExpired },
        });
        return true;
      });
      if (didExpire) expired += 1;
    }
  }

  return expired;
}
