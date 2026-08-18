import { describe, expect, test } from "vitest";
import { computeDiscountAmount, parseLoyaltySettings, pointsToRedeem } from "./discount";

describe("pointsToRedeem", () => {
  test("prefers the cart metafield over the cart attribute", () => {
    expect(pointsToRedeem(500, 300)).toBe(500);
    expect(pointsToRedeem(0, 300)).toBe(300);
    expect(pointsToRedeem(0, 0)).toBe(0);
  });
});

describe("computeDiscountAmount", () => {
  test("converts points using the redemption rate", () => {
    expect(
      computeDiscountAmount({
        points: 500,
        redemptionRate: 100,
        maxRedemptionPercent: 50,
        subtotal: 100,
      }),
    ).toBe(5);
  });

  test("caps at maxRedemptionPercent of the subtotal", () => {
    expect(
      computeDiscountAmount({
        points: 10000,
        redemptionRate: 100,
        maxRedemptionPercent: 50,
        subtotal: 40,
      }),
    ).toBe(20);
  });

  test("never exceeds the subtotal", () => {
    expect(
      computeDiscountAmount({
        points: 10000,
        redemptionRate: 100,
        maxRedemptionPercent: 0,
        subtotal: 12.5,
      }),
    ).toBe(12.5);
  });
});

describe("parseLoyaltySettings", () => {
  test("returns null for invalid JSON or a missing rate", () => {
    expect(parseLoyaltySettings("not-json")).toBeNull();
    expect(parseLoyaltySettings("{}")).toBeNull();
  });

  test("parses shop metafield settings", () => {
    expect(parseLoyaltySettings('{"redemptionRate":100,"maxRedemptionPercent":50}')).toEqual({
      redemptionRate: 100,
      maxRedemptionPercent: 50,
    });
  });
});
