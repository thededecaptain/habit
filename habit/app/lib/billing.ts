export const MONTHLY_PLAN = "Habit Monthly";
export const MONTHLY_PLAN_AMOUNT = 29;
export const MONTHLY_PLAN_CURRENCY = "USD";
export const MONTHLY_TRIAL_DAYS = 14;

/**
 * Test charges are used in local/dev so we never hit a real card.
 * Production (including App Store review) must send isTest: false.
 */
export function isBillingTest() {
  if (process.env.BILLING_TEST === "true") return true;
  if (process.env.BILLING_TEST === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export function supportEmail() {
  return process.env.SUPPORT_EMAIL || "support@habitloyalty.com";
}

export function publicAppUrl() {
  return (process.env.SHOPIFY_APP_URL || "https://habit-production-9257.up.railway.app").replace(
    /\/$/,
    "",
  );
}
