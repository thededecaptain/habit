import type { Prisma } from "@prisma/client";
import { Prisma as PrismaNS } from "@prisma/client";
import prisma from "../db.server";
import { decryptSecret } from "./secrets.server";

export const EVENT_POINTS_EARNED = "Habit: Points Earned";
export const EVENT_TIER_UPGRADED = "Habit: Tier Upgraded";
export const EVENT_REFERRAL_SENT = "Habit: Referral Sent";
export const EVENT_REFERRAL_WELCOME = "Habit: Referral Welcome Bonus";
export const EVENT_POINTS_REDEEMED = "Habit: Points Redeemed";
export const EVENT_POINTS_EXPIRING_SOON = "Habit: Points Expiring Soon";
export const EVENT_POINTS_EXPIRED = "Habit: Points Expired";

export const KLAVIYO_METRIC_NAMES = [
  EVENT_POINTS_EARNED,
  EVENT_TIER_UPGRADED,
  EVENT_REFERRAL_SENT,
  EVENT_REFERRAL_WELCOME,
  EVENT_POINTS_REDEEMED,
  EVENT_POINTS_EXPIRING_SOON,
  EVENT_POINTS_EXPIRED,
] as const;

const KLAVIYO_EVENTS_URL = "https://a.klaviyo.com/api/events/";
const KLAVIYO_REVISION = "2024-10-15";
const MAX_ATTEMPTS = 8;

type DbClient = Prisma.TransactionClient | typeof prisma;

export async function enqueueLoyaltyEvent(
  db: DbClient,
  params: {
    shop: string;
    eventName: string;
    customerEmail: string | null | undefined;
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

export async function trackKlaviyoEvent(params: {
  apiKey: string;
  eventName: string;
  customerEmail: string;
  properties: Record<string, unknown>;
  uniqueId: string;
}) {
  const response = await fetch(KLAVIYO_EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${params.apiKey}`,
      revision: KLAVIYO_REVISION,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          metric: {
            data: {
              type: "metric",
              attributes: { name: params.eventName },
            },
          },
          profile: {
            data: {
              type: "profile",
              attributes: { email: params.customerEmail },
            },
          },
          properties: params.properties,
          unique_id: params.uniqueId,
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Klaviyo responded ${response.status}`);
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

async function deliverOutboxRow(row: {
  shop: string;
  eventName: string;
  customerEmail: string;
  properties: Prisma.JsonValue;
  uniqueKey: string;
}) {
  const settings = await prisma.shopSettings.findUnique({ where: { shop: row.shop } });
  const properties = asProperties(row.properties);

  if (settings?.klaviyoEnabled && settings.klaviyoApiKeyEncrypted) {
    let apiKey: string;
    try {
      apiKey = decryptSecret(settings.klaviyoApiKeyEncrypted);
    } catch {
      throw new DecryptFailedError();
    }
    await trackKlaviyoEvent({
      apiKey,
      eventName: row.eventName,
      customerEmail: row.customerEmail,
      properties,
      uniqueId: row.uniqueKey,
    });
    return;
  }

  if (settings?.notificationWebhookUrl) {
    await postMerchantWebhook(
      settings.notificationWebhookUrl,
      row.eventName,
      row.customerEmail,
      properties,
    );
    return;
  }

  console.log(`Skipping notification ${row.eventName} for ${row.shop}: no destination configured`);
  return "skipped" as const;
}

class DecryptFailedError extends Error {
  constructor() {
    super("Could not decrypt Klaviyo key. Reconnect Klaviyo in Settings.");
    this.name = "DecryptFailedError";
  }
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
      const message =
        error instanceof DecryptFailedError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Send failed";

      if (error instanceof DecryptFailedError || attempts >= MAX_ATTEMPTS) {
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
