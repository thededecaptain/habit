export const STANDARD_PLAN = "Standard";
export const STANDARD_PLAN_AMOUNT = 49;
export const STANDARD_PLAN_CURRENCY = "USD";
export const STANDARD_PLAN_TRIAL_DAYS = 30;

/** App Store / hosted plan-page handle. Override with SHOPIFY_APP_HANDLE. */
export const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "habit";

/** Draft / public plan handle in Partner Dashboard Pricing. */
export const STANDARD_PLAN_HANDLE =
  process.env.SHOPIFY_STANDARD_PLAN_HANDLE || "standard";

/**
 * Habit is a flat $49 / 30-day subscription. There is no usage meter.
 * Do not send App Events or Billing API usage records — App Pricing would
 * have nothing to bill from them.
 */
export const USAGE_BILLING_ENABLED = false;

export function trialEndsAt(createdAt: string, trialDays: number) {
  const end = new Date(createdAt);
  end.setUTCDate(end.getUTCDate() + trialDays);
  return end;
}
