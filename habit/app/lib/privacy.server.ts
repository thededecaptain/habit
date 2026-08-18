import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { log } from "./logger.server";
import {
  buildCustomerDataExport,
  customerPiiRedactData,
} from "./privacy";

export async function fulfillCustomerDataRequest(params: {
  shop: string;
  shopifyCustomerId: string;
  payload: Prisma.InputJsonValue;
}) {
  const { shop, shopifyCustomerId, payload } = params;
  const customer = shopifyCustomerId
    ? await prisma.customer.findUnique({
        where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
        include: { pointTransactions: true, ownedReferralCodes: true },
      })
    : null;

  const exportData = buildCustomerDataExport({
    shop,
    customer,
    transactions: customer?.pointTransactions ?? [],
    referralCodes: customer?.ownedReferralCodes ?? [],
  });

  const request = await prisma.privacyRequest.create({
    data: {
      shop,
      type: "CUSTOMER_DATA_REQUEST",
      shopifyCustomerId: shopifyCustomerId || null,
      payload,
      exportData: exportData as Prisma.InputJsonValue,
      status: "fulfilled",
      fulfilledAt: new Date(),
    },
  });

  log("info", "privacy.customer_data_request", {
    shop,
    shopifyCustomerId,
    found: Boolean(customer),
    requestId: request.id,
  });

  return request;
}

export async function redactCustomerData(params: {
  shop: string;
  shopifyCustomerId: string;
  payload: Prisma.InputJsonValue;
}) {
  const { shop, shopifyCustomerId, payload } = params;
  const customer = shopifyCustomerId
    ? await prisma.customer.findUnique({
        where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      })
    : null;

  if (customer) {
    await prisma.$transaction([
      prisma.customer.update({
        where: { id: customer.id },
        data: customerPiiRedactData(),
      }),
      prisma.privacyRequest.updateMany({
        where: { shop, shopifyCustomerId },
        data: { exportData: Prisma.DbNull },
      }),
    ]);
  }

  await prisma.privacyRequest.create({
    data: {
      shop,
      type: "CUSTOMER_REDACT",
      shopifyCustomerId: shopifyCustomerId || null,
      payload,
      status: "fulfilled",
      fulfilledAt: new Date(),
    },
  });

  log("info", "privacy.customer_redact", {
    shop,
    shopifyCustomerId,
    found: Boolean(customer),
  });
}

export async function eraseShopData(shop: string) {
  await prisma.$transaction([
    prisma.pointTransaction.deleteMany({ where: { shop } }),
    prisma.referralCode.deleteMany({ where: { shop } }),
    prisma.privacyRequest.deleteMany({ where: { shop } }),
    prisma.customer.deleteMany({ where: { shop } }),
    prisma.vipTier.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);

  log("info", "privacy.shop_redact", { shop });
}
