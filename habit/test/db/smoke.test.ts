import { expect, test } from "vitest";
import { makeCustomer, prisma } from "../helpers/db";

test("runs against a freshly migrated, empty database", async () => {
  expect(await prisma.customer.count()).toBe(0);
  await makeCustomer({ pointsBalance: 5 });
  expect(await prisma.customer.count()).toBe(1);
});

test("each test starts from empty tables", async () => {
  expect(await prisma.customer.count()).toBe(0);
});
