import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ShopSettings } from "@prisma/client";
import db from "../db.server";
import { withTransientRetry } from "./transient-retry.server";

const REDEMPTION_FUNCTION_HANDLE = "points-redemption";
export const REDEMPTION_DISCOUNT_TITLE = "Loyalty points redemption";
// Must match the message returned by extensions/points-redemption/src/run.ts.
export const REDEMPTION_DISCOUNT_MESSAGE = "Loyalty points redeemed";

/** Current title of the shop's redemption discount (a merchant can rename it). */
export async function loadRedemptionDiscountTitle(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  discountId: string | null,
) {
  if (!discountId) return null;
  try {
    const response = await admin.graphql(
      `#graphql
      query RedemptionDiscountTitle($id: ID!) {
        discountNode(id: $id) {
          discount { ... on DiscountAutomaticApp { title } }
        }
      }`,
      { variables: { id: discountId } },
    );
    const json = await response.json();
    return (json?.data?.discountNode?.discount?.title as string | undefined) ?? null;
  } catch (error) {
    console.warn("Could not load redemption discount title", error);
    return null;
  }
}

/**
 * Pushes earn/redemption rates into a shop metafield so the
 * points-redemption Shopify Function and the storefront widget can read
 * them without calling our API.
 */
export async function syncLoyaltySettingsMetafield(
  admin: AdminApiContext,
  shop: string,
  settings: Pick<
    ShopSettings,
    "pointsPerDollar" | "redemptionRate" | "maxRedemptionPercent" | "minRedeemablePoints"
  >,
) {
  const shopJson = await withTransientRetry(async () => {
    const shopResponse = await admin.graphql(`#graphql
      query ShopId { shop { id } }
    `);
    return shopResponse.json();
  });
  const shopGid = shopJson?.data?.shop?.id;
  if (!shopGid) return;

  await withTransientRetry(() => admin.graphql(
    `#graphql
    mutation SetLoyaltySettings($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopGid,
            key: "loyalty_settings",
            type: "json",
            value: JSON.stringify({
              pointsPerDollar: Number(settings.pointsPerDollar),
              redemptionRate: Number(settings.redemptionRate),
              maxRedemptionPercent: Number(settings.maxRedemptionPercent),
              minRedeemablePoints: settings.minRedeemablePoints,
            }),
          },
        ],
      },
    },
  ));

  console.log(`Synced loyalty_settings metafield for ${shop}`);
}

/**
 * Ensures a Shopify Function-powered automatic discount exists for point
 * redemption. Idempotent: does nothing if we've already created one for
 * this shop (tracked via ShopSettings.discountAutomaticId).
 */
export async function ensureRedemptionDiscount(admin: AdminApiContext, shop: string) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (settings?.discountAutomaticId) return settings.discountAutomaticId;

  try {
    const response = await admin.graphql(
      `#graphql
      mutation CreateRedemptionDiscount($discount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $discount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          discount: {
            title: REDEMPTION_DISCOUNT_TITLE,
            functionHandle: REDEMPTION_FUNCTION_HANDLE,
            discountClasses: ["ORDER"],
            startsAt: new Date().toISOString(),
            combinesWith: {
              orderDiscounts: false,
              productDiscounts: true,
              shippingDiscounts: true,
            },
          },
        },
      },
    );
    const json = await response.json();
    const result = json?.data?.discountAutomaticAppCreate;
    const errors = result?.userErrors ?? [];
    if (errors.length > 0) {
      console.error("discountAutomaticAppCreate userErrors", errors);
      return null;
    }

    const discountId = result?.automaticAppDiscount?.discountId;
    if (discountId) {
      await db.shopSettings.update({
        where: { shop },
        data: { discountAutomaticId: discountId },
      });
    }
    return discountId ?? null;
  } catch (error) {
    console.error("Failed to create redemption discount", error);
    return null;
  }
}

export async function bootstrapShop(admin: AdminApiContext, shop: string) {
  const settings = await db.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  await syncLoyaltySettingsMetafield(admin, shop, settings);
  await ensureRedemptionDiscount(admin, shop);
}
