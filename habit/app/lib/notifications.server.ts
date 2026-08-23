import type { Prisma } from "@prisma/client";
import { Prisma as PrismaNS } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { buildFlowPayload, emitFlowTrigger } from "./flow.server";
import { FLOW_TRIGGER_HANDLES } from "./loyalty-events.server";

export {
  EVENT_POINTS_EARNED,
  EVENT_POINTS_EXPIRED,
  EVENT_POINTS_EXPIRING_SOON,
  EVENT_POINTS_REDEEMED,
  EVENT_REFERRAL_SENT,
  EVENT_REFERRAL_WELCOME,
  EVENT_TIER_UPGRADED,
  LOYALTY_EVENT_NAMES,
} from "./loyalty-events.server";

const MAX_ATTEMPTS = 8;

type DbClient = Prisma.TransactionClient | typeof prisma;

export async function enqueueLoyaltyEvent(
  db: DbClient,
  params: {
    shop: string;
    eventName: string;
    customerEmail: string | null | undefined;
    shopifyCustomerId?: string | null;
    orderId?: string | null;
    uniqueKey: string;
    properties: Record<string, unknown>;
  },
) {
  const email = params.customerEmail?.trim();
  if (!email) return;

  try {
    await db.notificationOutbox.create({
      data: {
        shop: params.shop,
        eventName: params.eventName,
        customerEmail: email,
        shopifyCustomerId: params.shopifyCustomerId ?? null,
        orderId: params.orderId ?? null,
        uniqueKey: params.uniqueKey,
        properties: params.properties as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}

async function postMerchantWebhook(
  url: string,
  eventName: string,
  customerEmail: string,
  properties: Record<string, unknown>,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventName, customerEmail, properties }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status}`);
  }
}

function asProperties(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function resolveShopifyCustomerId(
  shop: string,
  email: string,
  stored: string | null,
): Promise<string | null> {
  if (stored) return stored;
  const customer = await prisma.customer.findFirst({
    where: { shop, email },
    select: { shopifyCustomerId: true },
  });
  return customer?.shopifyCustomerId ?? null;
}

async function deliverOutboxRow(row: {
  shop: string;
  eventName: string;
  customerEmail: string;
  shopifyCustomerId: string | null;
  orderId: string | null;
  properties: Prisma.JsonValue;
}) {
  const settings = await prisma.shopSettings.findUnique({ where: { shop: row.shop } });
  const properties = asProperties(row.properties);
  const shopifyCustomerId = await resolveShopifyCustomerId(
    row.shop,
    row.customerEmail,
    row.shopifyCustomerId,
  );

  let delivered = false;
  const errors: string[] = [];

  const handle = FLOW_TRIGGER_HANDLES[row.eventName];
  if (handle) {
    const payload = buildFlowPayload({
      eventName: row.eventName,
      customerEmail: row.customerEmail,
      shopifyCustomerId,
      orderId: row.orderId,
      properties,
    });
    if (payload) {
      try {
        const { admin } = await unauthenticated.admin(row.shop);
        await emitFlowTrigger(admin, handle, payload);
        delivered = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Flow trigger failed";
        errors.push(`Flow: ${message}`);
      }
    } else {
      errors.push("Flow: missing customer or order id for trigger payload");
    }
  }

  if (settings?.notificationWebhookUrl) {
    try {
      await postMerchantWebhook(
        settings.notificationWebhookUrl,
        row.eventName,
        row.customerEmail,
        properties,
      );
      delivered = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook failed";
      errors.push(`Webhook: ${message}`);
    }
  }

  if (!delivered && errors.length === 0) {
    console.log(`Skipping notification ${row.eventName} for ${row.shop}: no destination configured`);
    return "skipped" as const;
  }

  if (!delivered) {
    throw new Error(errors.join("; "));
  }

  if (errors.length > 0) {
    console.warn(`Partial notification delivery for ${row.eventName} (${row.shop}): ${errors.join("; ")}`);
  }

  return "sent" as const;
}

const OUTBOX_BATCH = 50;

export async function processOutbox() {
  const now = new Date();
  const candidates = await prisma.notificationOutbox.findMany({
    where: { status: "PENDING", availableAt: { lte: now } },
    orderBy: { availableAt: "asc" },
    take: OUTBOX_BATCH,
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let retried = 0;

  for (const row of candidates) {
    const claimed = await prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const claimedRow = await prisma.notificationOutbox.findUnique({ where: { id: row.id } });
    const attempts = claimedRow?.attempts ?? row.attempts + 1;

    try {
      const result = await deliverOutboxRow(row);
      if (result === "skipped") {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: { status: "SKIPPED", processedAt: new Date(), lastError: null },
        });
        skipped += 1;
      } else {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: { status: "SENT", processedAt: new Date(), lastError: null },
        });
        sent += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Send failed";

      if (attempts >= MAX_ATTEMPTS) {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: { status: "FAILED", lastError: message, processedAt: new Date() },
        });
        failed += 1;
      } else {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: "PENDING",
            lastError: message,
            availableAt: new Date(Date.now() + 2 ** attempts * 60 * 1000),
          },
        });
        retried += 1;
      }
    }
  }

  return { claimed: candidates.length, sent, skipped, failed, retried };
}
