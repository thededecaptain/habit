export const EVENT_POINTS_EARNED = "Habit: Points Earned";
export const EVENT_TIER_UPGRADED = "Habit: Tier Upgraded";
export const EVENT_REFERRAL_SENT = "Habit: Referral Sent";
export const EVENT_REFERRAL_WELCOME = "Habit: Referral Welcome Bonus";
export const EVENT_POINTS_REDEEMED = "Habit: Points Redeemed";
export const EVENT_POINTS_EXPIRING_SOON = "Habit: Points Expiring Soon";
export const EVENT_POINTS_EXPIRED = "Habit: Points Expired";

export const LOYALTY_EVENT_NAMES = [
  EVENT_POINTS_EARNED,
  EVENT_TIER_UPGRADED,
  EVENT_REFERRAL_SENT,
  EVENT_REFERRAL_WELCOME,
  EVENT_POINTS_REDEEMED,
  EVENT_POINTS_EXPIRING_SOON,
  EVENT_POINTS_EXPIRED,
] as const;

export const FLOW_TRIGGER_HANDLES: Record<string, string> = {
  [EVENT_POINTS_EARNED]: "points-earned",
  [EVENT_TIER_UPGRADED]: "tier-upgraded",
  [EVENT_REFERRAL_SENT]: "referral-sent",
  [EVENT_REFERRAL_WELCOME]: "referral-welcome-bonus",
  [EVENT_POINTS_REDEEMED]: "points-redeemed",
  [EVENT_POINTS_EXPIRING_SOON]: "points-expiring-soon",
  [EVENT_POINTS_EXPIRED]: "points-expired",
};
