import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ShopSettings } from "@prisma/client";
import db from "../db.server";

const REDEMPTION_FUNCTION_HANDLE = "points-redemption";

/**
 * Pushes the redemption rate + cap into a shop metafield so the
 * points-redemption Shopify Function (which can't call our API — Functions
 * have no network access) can read current settings at checkout time.
 */
export async function syncLoyaltySettingsMetafield(
  admin: AdminApiContext,
  shop: string,
  settings: Pick<ShopSettings, "redemptionRate" | "maxRedemptionPercent">,
) {
  const shopResponse = await admin.graphql(`#graphql
    query ShopId { shop { id } }
  `);
  const shopJson = await shopResponse.json();
  const shopGid = shopJson?.data?.shop?.id;
  if (!shopGid) return;

  await admin.graphql(
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
            namespace: "$app",
            key: "loyalty_settings",
            type: "json",
            value: JSON.stringify({
              redemptionRate: Number(settings.redemptionRate),
              maxRedemptionPercent: Number(settings.maxRedemptionPercent),
            }),
          },
        ],
      },
    },
  );

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
            title: "Loyalty points redemption",
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
