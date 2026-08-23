import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  EVENT_POINTS_EARNED,
  EVENT_POINTS_EXPIRED,
  EVENT_POINTS_EXPIRING_SOON,
  EVENT_POINTS_REDEEMED,
  EVENT_REFERRAL_SENT,
  EVENT_REFERRAL_WELCOME,
  EVENT_TIER_UPGRADED,
} from "./notifications.server";

export const FLOW_TRIGGER_HANDLES: Record<string, string> = {
  [EVENT_POINTS_EARNED]: "points-earned",
  [EVENT_TIER_UPGRADED]: "tier-upgraded",
  [EVENT_REFERRAL_SENT]: "referral-sent",
  [EVENT_REFERRAL_WELCOME]: "referral-welcome-bonus",
  [EVENT_POINTS_REDEEMED]: "points-redeemed",
  [EVENT_POINTS_EXPIRING_SOON]: "points-expiring-soon",
  [EVENT_POINTS_EXPIRED]: "points-expired",
};

function legacyId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function decimal(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function buildFlowPayload(params: {
  eventName: string;
  customerEmail: string;
  shopifyCustomerId?: string | null;
  orderId?: string | null;
  properties: Record<string, unknown>;
}): Record<string, unknown> | null {
  const customerId = legacyId(params.shopifyCustomerId);
  if (!customerId) return null;

  const base = {
    customer_id: customerId,
    "Customer email": params.customerEmail,
  };

  const props = params.properties;
  const orderId = legacyId(params.orderId ?? props.orderId);

  switch (params.eventName) {
    case EVENT_POINTS_EARNED:
      if (!orderId) return null;
      return {
        ...base,
        order_id: orderId,
        Points: decimal(props.points),
        "Points balance": decimal(props.pointsBalance),
      };
    case EVENT_TIER_UPGRADED:
      return {
        ...base,
        "Tier name": text(props.tierName),
        "Lifetime spend": decimal(props.lifetimeSpend),
        "Lifetime orders": decimal(props.lifetimeOrders),
      };
    case EVENT_REFERRAL_SENT:
    case EVENT_REFERRAL_WELCOME:
      return {
        ...base,
        "Bonus points": decimal(props.bonusPoints),
        "Referral code": text(props.code),
      };
    case EVENT_POINTS_REDEEMED:
      if (!orderId) return null;
      return {
        ...base,
        order_id: orderId,
        Points: decimal(props.points),
        "Points balance": decimal(props.pointsBalance),
      };
    case EVENT_POINTS_EXPIRING_SOON:
      return {
        ...base,
        "Points balance": decimal(props.pointsBalance),
        "Expires in days": decimal(props.expiresInDays),
        "Expires on": text(props.expiresOn),
      };
    case EVENT_POINTS_EXPIRED:
      return {
        ...base,
        "Points expired": decimal(props.pointsExpired),
      };
    default:
      return null;
  }
}

export async function emitFlowTrigger(
  admin: AdminApiContext,
  handle: string,
  payload: Record<string, unknown>,
) {
  const response = await admin.graphql(
    `#graphql
    mutation FlowTriggerReceive($handle: String!, $payload: JSON!) {
      flowTriggerReceive(handle: $handle, payload: $payload) {
        userErrors { field message }
      }
    }`,
    { variables: { handle, payload } },
  );
  const json = await response.json();
  const errors = json?.data?.flowTriggerReceive?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
  }
}
