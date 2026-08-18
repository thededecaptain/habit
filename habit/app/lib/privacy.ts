export type CustomerExportInput = {
  shopifyCustomerId: string;
  email: string | null;
  displayName: string | null;
  pointsBalance: number;
  lifetimeSpend: unknown;
  lifetimeOrders: number;
  createdAt: Date;
};

export type TransactionExportInput = {
  type: string;
  points: number;
  orderId: string | null;
  description: string | null;
  createdAt: Date;
};

export type ReferralExportInput = {
  code: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
};

export function buildCustomerDataExport(params: {
  shop: string;
  customer: CustomerExportInput | null;
  transactions: TransactionExportInput[];
  referralCodes: ReferralExportInput[];
}) {
  const { shop, customer, transactions, referralCodes } = params;
  return {
    shop,
    exportedAt: new Date().toISOString(),
    customer: customer
      ? {
          shopifyCustomerId: customer.shopifyCustomerId,
          email: customer.email,
          displayName: customer.displayName,
          pointsBalance: customer.pointsBalance,
          lifetimeSpend: Number(customer.lifetimeSpend),
          lifetimeOrders: customer.lifetimeOrders,
          createdAt: customer.createdAt.toISOString(),
        }
      : null,
    pointTransactions: transactions.map((row) => ({
      type: row.type,
      points: row.points,
      orderId: row.orderId,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    })),
    referralCodes: referralCodes.map((row) => ({
      code: row.code,
      status: row.status,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export function customerPiiRedactData(now = new Date()) {
  return {
    email: null as string | null,
    displayName: null as string | null,
    redactedAt: now,
  };
}
