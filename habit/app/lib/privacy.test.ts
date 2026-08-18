import { describe, expect, test } from "vitest";
import { buildCustomerDataExport, customerPiiRedactData } from "./privacy";

describe("buildCustomerDataExport", () => {
  test("serializes ledger data for a merchant data request", () => {
    const createdAt = new Date("2026-08-01T12:00:00.000Z");
    const exportData = buildCustomerDataExport({
      shop: "example.myshopify.com",
      customer: {
        shopifyCustomerId: "123",
        email: "buyer@example.com",
        displayName: "Ada Lovelace",
        pointsBalance: 80,
        lifetimeSpend: 120.5,
        lifetimeOrders: 3,
        createdAt,
      },
      transactions: [
        {
          type: "EARN",
          points: 80,
          orderId: "gid://shopify/Order/1",
          description: "Earned on order",
          createdAt,
        },
      ],
      referralCodes: [
        {
          code: "ABCD2345",
          status: "ACTIVE",
          expiresAt: createdAt,
          createdAt,
        },
      ],
    });

    expect(exportData.customer?.email).toBe("buyer@example.com");
    expect(exportData.customer?.lifetimeSpend).toBe(120.5);
    expect(exportData.pointTransactions).toHaveLength(1);
    expect(exportData.referralCodes[0]?.code).toBe("ABCD2345");
  });

  test("returns a null customer when nothing is on file", () => {
    const exportData = buildCustomerDataExport({
      shop: "example.myshopify.com",
      customer: null,
      transactions: [],
      referralCodes: [],
    });
    expect(exportData.customer).toBeNull();
    expect(exportData.pointTransactions).toEqual([]);
  });
});

describe("customerPiiRedactData", () => {
  test("clears email and display name", () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    expect(customerPiiRedactData(now)).toEqual({
      email: null,
      displayName: null,
      redactedAt: now,
    });
  });
});
