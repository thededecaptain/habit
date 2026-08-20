import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { bootstrapShop } from "./lib/discount.server";
import {
  STANDARD_PLAN,
  STANDARD_PLAN_AMOUNT,
  STANDARD_PLAN_CURRENCY,
  STANDARD_PLAN_TRIAL_DAYS,
} from "./lib/billing-plan";

export { STANDARD_PLAN, STANDARD_PLAN_AMOUNT, STANDARD_PLAN_TRIAL_DAYS };

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [STANDARD_PLAN]: {
      trialDays: STANDARD_PLAN_TRIAL_DAYS,
      lineItems: [
        {
          amount: STANDARD_PLAN_AMOUNT,
          currencyCode: STANDARD_PLAN_CURRENCY,
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Seed default settings, sync the loyalty metafield, and create the
      // Function-powered redemption discount so the app works immediately
      // after install without requiring a trip to the Settings page.
      await bootstrapShop(admin, session.shop);
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
