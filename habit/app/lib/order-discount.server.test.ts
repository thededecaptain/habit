import assert from "node:assert/strict";
import { test } from "node:test";
import { loyaltyDiscountAmount, pointsForDiscount } from "./order-discount.server";

const TITLES = ["Loyalty points redemption", "Loyalty points redeemed"];

test("sums the loyalty discount's allocations across lines", () => {
  const amount = loyaltyDiscountAmount(
    {
      discount_applications: [
        { type: "discount_code", title: "WELCOME10", value: "10.0" },
        { type: "automatic", title: "Loyalty points redemption", value: "25.0" },
      ],
      line_items: [
        { discount_allocations: [{ amount: "5.00", discount_application_index: 0 }, { amount: "15.00", discount_application_index: 1 }] },
        { discount_allocations: [{ amount: "10.00", discount_application_index: 1 }] },
      ],
    },
    TITLES,
  );
  assert.equal(amount, 25);
});

test("prefers the presentment amount on multi-currency orders", () => {
  const amount = loyaltyDiscountAmount(
    {
      discount_applications: [{ type: "automatic", title: "Loyalty points redeemed", value: "5.0" }],
      line_items: [
        {
          discount_allocations: [
            { amount: "5.40", amount_set: { presentment_money: { amount: "5.00" } }, discount_application_index: 0 },
          ],
        },
      ],
    },
    TITLES,
  );
  assert.equal(amount, 5);
});

test("falls back to the application value when there are no allocations", () => {
  const amount = loyaltyDiscountAmount(
    { discount_applications: [{ type: "automatic", title: "Loyalty points redemption", value: "3.00" }], line_items: [] },
    TITLES,
  );
  assert.equal(amount, 3);
});

test("returns null when the order has no loyalty discount", () => {
  assert.equal(
    loyaltyDiscountAmount(
      { discount_applications: [{ type: "automatic", title: "Summer sale", value: "10.0" }] },
      TITLES,
    ),
    null,
  );
  assert.equal(loyaltyDiscountAmount({}, TITLES), null);
});

test("pointsForDiscount converts at the redemption rate and caps at the request", () => {
  assert.equal(pointsForDiscount(25, 100, 5000), 2500);
  assert.equal(pointsForDiscount(25, 100, 1000), 1000);
  assert.equal(pointsForDiscount(3.33, 3, 10), 10);
  assert.equal(pointsForDiscount(0, 100, 500), 0);
  assert.equal(pointsForDiscount(10, 0, 500), 0);
});

test("pointsForDiscount charges the discount's worth when no request reached the order", () => {
  assert.equal(pointsForDiscount(4.33, 100, 0), 433);
});
