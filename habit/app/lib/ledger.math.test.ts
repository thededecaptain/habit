import { describe, expect, test } from "vitest";
import {
  calculateEarnPoints,
  calculateRefundReversalPoints,
  clampRedemption,
  generateReferralCode,
  REFERRAL_CODE_CHARS,
  resolveVipTier,
} from "./ledger.math";

const bronze = {
  name: "Bronze",
  minSpend: 0,
  minOrders: 0,
  earnMultiplier: 1,
  sortOrder: 0,
};
const silver = {
  name: "Silver",
  minSpend: 250,
  minOrders: 5,
  earnMultiplier: 1.25,
  sortOrder: 1,
};
const gold = {
  name: "Gold",
  minSpend: 1000,
  minOrders: null,
  earnMultiplier: 1.5,
  sortOrder: 2,
};

describe("resolveVipTier", () => {
  test("returns null when no tiers qualify", () => {
    expect(resolveVipTier([silver, gold], 10, 1)).toBeNull();
  });

  test("picks the highest sortOrder among qualifying tiers", () => {
    expect(resolveVipTier([bronze, silver, gold], 1200, 2)?.name).toBe("Gold");
    expect(resolveVipTier([bronze, silver, gold], 300, 6)?.name).toBe("Silver");
  });

  test("ignores a null threshold on that axis", () => {
    expect(resolveVipTier([gold], 1000, 0)?.name).toBe("Gold");
  });
});

describe("calculateEarnPoints", () => {
  test("floors the product of subtotal, rate, and multiplier", () => {
    expect(calculateEarnPoints(49.9, 1, 1)).toBe(49);
    expect(calculateEarnPoints(50, 1, 1.5)).toBe(75);
  });

  test("returns 0 for non-positive inputs", () => {
    expect(calculateEarnPoints(0, 1, 1)).toBe(0);
    expect(calculateEarnPoints(20, 0, 1)).toBe(0);
  });
});

describe("calculateRefundReversalPoints", () => {
  test("reverses the full earn on a full refund", () => {
    expect(
      calculateRefundReversalPoints({
        earnedPoints: 100,
        alreadyReversedPoints: 0,
        refundedAmount: 50,
        orderSubtotal: 50,
      }),
    ).toBe(100);
  });

  test("reverses proportionally on a partial refund", () => {
    expect(
      calculateRefundReversalPoints({
        earnedPoints: 100,
        alreadyReversedPoints: 0,
        refundedAmount: 25,
        orderSubtotal: 50,
      }),
    ).toBe(50);
  });

  test("does not reverse more than the remaining earn", () => {
    expect(
      calculateRefundReversalPoints({
        earnedPoints: 100,
        alreadyReversedPoints: 80,
        refundedAmount: 50,
        orderSubtotal: 50,
      }),
    ).toBe(20);
  });

  test("returns 0 when already fully reversed", () => {
    expect(
      calculateRefundReversalPoints({
        earnedPoints: 100,
        alreadyReversedPoints: 100,
        refundedAmount: 10,
        orderSubtotal: 50,
      }),
    ).toBe(0);
  });

  test("falls back to a full reversal when subtotal is 0", () => {
    expect(
      calculateRefundReversalPoints({
        earnedPoints: 40,
        alreadyReversedPoints: 0,
        refundedAmount: 5,
        orderSubtotal: 0,
      }),
    ).toBe(40);
  });
});

describe("clampRedemption", () => {
  test("clamps to the current balance", () => {
    expect(clampRedemption(200, 80)).toBe(80);
    expect(clampRedemption(50, 80)).toBe(50);
  });

  test("never deducts from a negative or empty balance", () => {
    expect(clampRedemption(20, 0)).toBe(0);
    expect(clampRedemption(20, -15)).toBe(0);
    expect(clampRedemption(0, 50)).toBe(0);
  });
});

describe("generateReferralCode", () => {
  test("uses the unambiguous alphabet", () => {
    const code = generateReferralCode(8, () => 0);
    expect(code).toBe("AAAAAAAA");
    expect([...code].every((ch) => REFERRAL_CODE_CHARS.includes(ch))).toBe(true);
  });
});
