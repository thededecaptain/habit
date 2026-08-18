import { describe, expect, test } from "vitest";
import { nextTierProgress } from "./loyalty.math";

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
  minOrders: 12,
  earnMultiplier: 1.5,
  sortOrder: 2,
};

describe("nextTierProgress", () => {
  test("returns remaining spend and orders for the next tier", () => {
    expect(nextTierProgress([silver, gold], silver, 400, 6)).toEqual({
      nextTierName: "Gold",
      nextTierRemainingSpend: 600,
      nextTierRemainingOrders: 6,
    });
  });

  test("returns nulls at the top tier", () => {
    expect(nextTierProgress([silver, gold], gold, 2000, 20)).toEqual({
      nextTierName: null,
      nextTierRemainingSpend: null,
      nextTierRemainingOrders: null,
    });
  });

  test("starts from the lowest tier when the customer has none", () => {
    expect(nextTierProgress([silver, gold], null, 0, 0)).toEqual({
      nextTierName: "Silver",
      nextTierRemainingSpend: 250,
      nextTierRemainingOrders: 5,
    });
  });
});
