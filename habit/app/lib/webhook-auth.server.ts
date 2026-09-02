import crypto from "node:crypto";
import { authenticate } from "../shopify.server";

type WebhookAuthResult = {
  shop: string;
  topic: string;
  payload: Record<string, unknown>;
  session: unknown;
  admin: unknown;
};

/**
 * authenticate.webhook() refreshes expiring offline tokens before returning.
 * On APP_UNINSTALLED / SHOP_REDACT the access + refresh tokens are already
 * revoked, so that refresh throws Response(500) / InvalidJwtError *before*
 * our handler runs — Shopify then retries for days.
 *
 * For cleanup / GDPR webhooks we only need a verified HMAC + shop domain.
 * Fall back to HMAC-only auth when token refresh fails after a valid signature.
 */
export async function authenticateWebhookSafe(
  request: Request,
): Promise<WebhookAuthResult> {
  const fallbackRequest = request.clone();
  try {
    return (await authenticate.webhook(request)) as WebhookAuthResult;
  } catch (error) {
    if (error instanceof Response) {
      if (error.status === 401 || error.status === 400 || error.status === 405) {
        throw error;
      }
    }
    console.error(
      "Webhook session refresh failed; continuing with HMAC-only auth",
      error instanceof Error ? error.message : error,
    );
    return authenticateWebhookHmacOnly(fallbackRequest);
  }
}

async function authenticateWebhookHmacOnly(
  request: Request,
): Promise<WebhookAuthResult> {
  if (request.method !== "POST") {
    throw new Response(undefined, {
      status: 405,
      statusText: "Method not allowed",
    });
  }

  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const topicHeader = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain");
  const apiVersion = request.headers.get("x-shopify-api-version");
  const webhookId = request.headers.get("x-shopify-webhook-id");

  if (!hmacHeader || !topicHeader || !shop || !apiVersion || !webhookId) {
    throw new Response(undefined, { status: 400, statusText: "Bad Request" });
  }

  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(rawBody, "utf8")
    .digest("base64");

  if (!timingSafeEqualString(digest, hmacHeader)) {
    throw new Response(undefined, { status: 401, statusText: "Unauthorized" });
  }

  return {
    shop,
    topic: topicHeader.toUpperCase().replace(/\//g, "_"),
    payload: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    session: undefined,
    admin: undefined,
  };
}

function timingSafeEqualString(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
